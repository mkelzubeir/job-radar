import { useEffect, useMemo, useRef, useState } from "react";
import { ADAPTERS, scanCompanies } from "./lib/ats";
import { extractResumeText, extractKeywords } from "./lib/resume";
import { rankJobs } from "./lib/match";
import { semanticRank, clearAiCache, extractProfile } from "./lib/ai";
import seedCompanies from "./data/companies.json";

const LS = {
  companies: "jobradar.companies",
  keywords: "jobradar.keywords",
  titles: "jobradar.titles",
  resumeText: "jobradar.resumeText",
  seedVersion: "jobradar.seedVersion",
  candidates: "jobradar.candidateCount",
};

// Bump when companies.json changes so returning users get new seed entries.
// v3: verified every board live; fixed 7 slugs/ATSs, dropped 5 unverifiable.
// v4: mass discovery via npm run discover — ~538 verified boards, +recruitee/breezy.
const SEED_VERSION = 4;

const load = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};

// A huge watchlist can blow the localStorage quota — persist best-effort and
// swallow quota errors so the app keeps working (just without persistence).
let quotaWarned = false;
const save = (k, value) => {
  try {
    localStorage.setItem(k, JSON.stringify(value));
  } catch {
    if (!quotaWarned) {
      quotaWarned = true;
      console.warn(`localStorage full — "${k}" not persisted this session.`);
    }
  }
};

const coKey = (c) => `${c.ats}:${c.slug}`.toLowerCase();

// Map an Anthropic API failure to short, human-readable copy. Errors thrown by
// src/lib/ai.js carry `.status` (undefined for network/CORS failures).
const humanizeAiError = (e) => {
  const s = e?.status;
  if (s === 401) return "401 · Invalid API key";
  if (s === 429) return "429 · Rate limited, try again shortly";
  if (s === 400) return `400 · ${e.message || "Bad request"}`;
  if (s) return `${s} · ${e.message || "Request failed"}`;
  return "Request blocked — check the browser console (network/CORS)";
};

// Merge the current seed into the user's stored list when the seed version has
// advanced: dedupe by ats:slug (case-insensitive), keep user-added entries, and
// append any missing seed entries. NOTE: a user who deleted a seed company will
// see it resurface on a version bump — acceptable tradeoff for delivering updates.
function loadCompanies() {
  const stored = load(LS.companies, null);
  if (!stored) {
    localStorage.setItem(LS.seedVersion, JSON.stringify(SEED_VERSION));
    return seedCompanies;
  }
  const storedVersion = load(LS.seedVersion, 0);
  if (storedVersion >= SEED_VERSION) return stored;

  const seen = new Set(stored.map(coKey));
  const merged = [...stored];
  for (const c of seedCompanies) {
    if (!seen.has(coKey(c))) {
      merged.push(c);
      seen.add(coKey(c));
    }
  }
  localStorage.setItem(LS.seedVersion, JSON.stringify(SEED_VERSION));
  return merged;
}

const timeAgo = (iso) => {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
};

export default function App() {
  const [companies, setCompanies] = useState(loadCompanies);
  const [keywords, setKeywords] = useState(() => load(LS.keywords, []));
  const [aiKeywords, setAiKeywords] = useState(false); // chips came from AI profile
  const [targetTitles, setTargetTitles] = useState(() => load(LS.titles, ""));
  const [resumeText, setResumeText] = useState(() => load(LS.resumeText, ""));
  const [resumeName, setResumeName] = useState("");
  const [jobs, setJobs] = useState([]);
  const [errors, setErrors] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState([0, 0]);
  const [scannedAt, setScannedAt] = useState(null);

  // AI profile (Claude) — cached in ai.js by résumé hash.
  const [profile, setProfile] = useState(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileErr, setProfileErr] = useState(null);

  // Smart rank (Stage 3). The API key lives ONLY in state — never persisted.
  const [aiKey, setAiKey] = useState("");
  const [candidateCount, setCandidateCount] = useState(() => load(LS.candidates, 60));
  const [aiScores, setAiScores] = useState(() => new Map());
  const [aiBusy, setAiBusy] = useState(false);
  const [aiProgress, setAiProgress] = useState([0, 0]);
  const [aiError, setAiError] = useState(null);
  const [aiWarnings, setAiWarnings] = useState([]);

  // Semantic boost (Stage 2) — optional local embeddings, no API key.
  const [semBoost, setSemBoost] = useState(false);
  const [semScores, setSemScores] = useState(() => new Map());
  const [semBusy, setSemBusy] = useState(false);
  const [semProgress, setSemProgress] = useState([0, 0]);
  const [semWarn, setSemWarn] = useState(null);
  const embedCacheRef = useRef(new Map());

  // Filters
  const [q, setQ] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [compOnly, setCompOnly] = useState(false);
  const [minMatch, setMinMatch] = useState(0);
  const [expanded, setExpanded] = useState(null);

  // Add-company form + watchlist filter + collapsible errors
  const [newCo, setNewCo] = useState({ name: "", ats: "ashby", slug: "" });
  const [coFilter, setCoFilter] = useState("");
  const [errorsOpen, setErrorsOpen] = useState(false);
  const fileRef = useRef(null);
  const importRef = useRef(null);

  useEffect(() => save(LS.companies, companies), [companies]);
  useEffect(() => save(LS.keywords, keywords), [keywords]);
  useEffect(() => save(LS.titles, targetTitles), [targetTitles]);
  useEffect(() => save(LS.resumeText, resumeText), [resumeText]);
  useEffect(() => save(LS.candidates, candidateCount), [candidateCount]);

  // A new scan invalidates the per-scan embedding cache and any boost scores.
  useEffect(() => {
    embedCacheRef.current = new Map();
    setSemScores(new Map());
  }, [jobs]);

  // Turn the résumé into a structured profile (primary path when a key exists).
  async function runProfile(text) {
    const key = aiKey.trim();
    if (!key) {
      setProfileErr("Enter your Anthropic API key below first.");
      return;
    }
    if (!text) return;
    setProfileBusy(true);
    setProfileErr(null);
    try {
      const p = await extractProfile(text, key);
      setProfile(p);
      const kws = [
        ...p.skills.map((s) => ({ term: s.term, weight: s.weight })),
        ...p.domains.map((d) => ({ term: d, weight: 6 })),
      ].filter((k) => k.term);
      if (kws.length) {
        setKeywords(kws);
        setAiKeywords(true);
      }
      if (!targetTitles.trim() && p.titles.length) {
        setTargetTitles(p.titles.join(", "));
      }
    } catch (e) {
      console.error("Analyze with AI failed:", e); // surface CORS/network detail
      setProfileErr(humanizeAiError(e));
    } finally {
      setProfileBusy(false);
    }
  }

  async function onResume(file) {
    if (!file) return;
    setResumeName(file.name);
    setProfile(null);
    setAiKeywords(false);
    try {
      const text = await extractResumeText(file);
      setResumeText(text);
      setKeywords(extractKeywords(text)); // keyless fallback; AI overrides below
      if (aiKey.trim()) runProfile(text);
    } catch (e) {
      setErrors((prev) => [...prev, { company: "Resume", ats: "-", message: e.message }]);
    }
  }

  async function scan() {
    setScanning(true);
    setErrors([]);
    setJobs([]);
    setProgress([0, companies.length]);

    // Stream jobs into the UI as boards resolve, flushing at most ~every 400ms
    // so a scan of hundreds of companies feels alive without thrashing React.
    const acc = [];
    let lastFlush = 0;
    const flush = () => setJobs(acc.slice());

    const { errors: errs } = await scanCompanies(companies, {
      concurrency: 12,
      onProgress: (d, t) => setProgress([d, t]),
      onJobs: (res) => {
        acc.push(...res);
        const now = Date.now();
        if (now - lastFlush > 400) {
          lastFlush = now;
          flush();
        }
      },
    });

    flush(); // final flush (ranking recomputes here on the full set)
    setErrors(errs);
    setScannedAt(new Date());
    setScanning(false);
  }

  const titlesArr = targetTitles.split(",").map((s) => s.trim()).filter(Boolean);

  // Distinct ATS platforms in the current watchlist — drives the hero copy.
  const atsCount = new Set(companies.map((c) => c.ats)).size;

  // Watchlist filter (the list can be hundreds long).
  const coFilterLc = coFilter.trim().toLowerCase();
  const filteredCompanies = coFilterLc
    ? companies.filter(
        (c) =>
          c.name.toLowerCase().includes(coFilterLc) ||
          c.slug.toLowerCase().includes(coFilterLc) ||
          (ADAPTERS[c.ats]?.label || c.ats).toLowerCase().includes(coFilterLc)
      )
    : companies;

  // Stage 1 (retrieval): TF-IDF over the whole scan.
  const ranked = useMemo(
    () => rankJobs(jobs, keywords, titlesArr),
    [jobs, keywords, targetTitles] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Stage 2 (optional): blend local embeddings into the keyword-stage score.
  useEffect(() => {
    if (!semBoost || !resumeText || !ranked.length) return;
    let cancelled = false;
    (async () => {
      setSemBusy(true);
      setSemWarn(null);
      setSemProgress([0, 0]);
      try {
        const { semanticBoost } = await import("./lib/embed");
        const candidates = ranked.slice(0, 400);
        const scores = await semanticBoost(
          resumeText,
          candidates,
          embedCacheRef.current,
          (d, t) => !cancelled && setSemProgress([d, t])
        );
        if (!cancelled) setSemScores(scores);
      } catch {
        if (!cancelled) {
          setSemWarn("Semantic boost unavailable (model failed to load) — using keyword ranking.");
          setSemBoost(false);
        }
      } finally {
        if (!cancelled) setSemBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [semBoost, ranked, resumeText]);

  // Effective keyword-stage score = blended (if boost active) else TF-IDF.
  const boosted = useMemo(() => {
    if (!semBoost || !semScores.size) return ranked;
    return ranked.map((j) => ({ ...j, match: semScores.get(j.id) ?? j.match }));
  }, [ranked, semBoost, semScores]);

  const withAi = useMemo(
    () => boosted.map((j) => ({ ...j, ai: aiScores.get(String(j.id)) || null })),
    [boosted, aiScores]
  );

  // The primary score is the AI score when present, else the keyword score.
  const primaryScore = (j) => (j.ai ? j.ai.score : j.match);

  const visible = withAi.filter((j) => {
    if (remoteOnly && !j.remote) return false;
    if (compOnly && !j.comp) return false;
    if (primaryScore(j) < minMatch) return false; // filter on whichever score is primary
    if (q) {
      const hay = `${j.company} ${j.title} ${j.location}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  // AI-scored jobs first (by AI score), then unscored jobs by keyword score.
  const shown = [...visible].sort((a, b) => {
    if (!!a.ai !== !!b.ai) return a.ai ? -1 : 1;
    if (a.ai && b.ai) return b.ai.score - a.ai.score || b.match - a.match;
    return (
      b.match - a.match ||
      (b.postedAt || "").localeCompare(a.postedAt || "")
    );
  });

  const removeKeyword = (term) => setKeywords(keywords.filter((k) => k.term !== term));
  const addCompany = () => {
    if (!newCo.slug.trim()) return;
    setCompanies([
      ...companies,
      { name: newCo.name.trim() || newCo.slug.trim(), ats: newCo.ats, slug: newCo.slug.trim() },
    ]);
    setNewCo({ name: "", ats: newCo.ats, slug: "" });
  };

  function exportWatchlist() {
    const blob = new Blob([JSON.stringify(companies, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "job-radar-watchlist.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importWatchlist(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data) || !data.every((c) => c && c.ats && c.slug)) {
        throw new Error("Expected a JSON array of { name, ats, slug } items.");
      }
      setCompanies(
        data.map((c) => ({ name: c.name || c.slug, ats: c.ats, slug: c.slug }))
      );
    } catch (e) {
      setErrors((prev) => [
        ...prev,
        { company: "Import", ats: "-", message: e.message },
      ]);
    }
  }

  function restoreDefaults() {
    if (!confirm("Reset your watchlist to the bundled default list? Any companies you added will be removed.")) {
      return;
    }
    setCompanies(seedCompanies);
    localStorage.setItem(LS.seedVersion, JSON.stringify(SEED_VERSION));
  }

  async function runSmartRank() {
    if (!aiKey.trim() || !resumeText.trim() || !ranked.length || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    setAiWarnings([]);
    setAiProgress([0, 0]);
    try {
      const candidates = boosted.slice(0, candidateCount);
      const { scores, warnings } = await semanticRank(
        resumeText,
        candidates,
        aiKey.trim(),
        { onProgress: (d, t) => setAiProgress([d, t]), profile }
      );
      setAiScores(scores);
      setAiWarnings(warnings);
    } catch (e) {
      console.error("Smart rank failed:", e);
      setAiError(humanizeAiError(e));
    } finally {
      setAiBusy(false);
    }
  }

  function clearSmartRank() {
    clearAiCache();
    setAiScores(new Map());
    setAiWarnings([]);
    setAiError(null);
    setProfile(null);
  }

  const hasScores = keywords.length + titlesArr.length > 0;

  return (
    <>
      <header>
        <div className="head-inner">
          <div className="brand">
            <h1>
              Job <span>Radar</span>
            </h1>
            <p>
              Upload a resume, scan the hidden job boards of {companies.length} companies
              across {atsCount} ATS {atsCount === 1 ? "platform" : "platforms"}, and get
              every open role ranked against you. Everything runs in your browser.
            </p>
          </div>
          <button className="scan-btn" onClick={scan} disabled={scanning}>
            {scanning ? `Scanning ${progress[0]}/${progress[1]}…` : "Scan all boards"}
          </button>
        </div>
      </header>

      <div className="wrap">
        <div className="grid">
          <aside className="panel">
            {/* Resume */}
            <section className="card">
              <h3>1 · Resume</h3>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.txt,.md"
                hidden
                onChange={(e) => onResume(e.target.files[0])}
              />
              <button className="upload" onClick={() => fileRef.current.click()}>
                {resumeName ? `↻ ${resumeName}` : "Upload PDF or TXT"}
              </button>
              {resumeText && (
                <>
                  <button
                    className="wl-btn analyze-btn"
                    onClick={() => runProfile(resumeText)}
                    disabled={!aiKey.trim() || profileBusy}
                    title={aiKey.trim() ? "" : "Enter your Anthropic API key below first"}
                  >
                    {profileBusy ? (
                      <>
                        <span className="spinner" aria-hidden="true" /> Analyzing…
                      </>
                    ) : profile ? (
                      "↻ Re-analyze with AI"
                    ) : (
                      "Analyze with AI"
                    )}
                  </button>
                  {!aiKey.trim() && (
                    <p className="hint analyze-hint">
                      Enter your Anthropic API key below (§4 · Smart rank) first.
                    </p>
                  )}
                </>
              )}
              <p className="hint">
                Parsed locally with pdf.js. With an API key, "Analyze with AI"
                extracts a structured profile; otherwise keywords are pulled locally.
              </p>
              {profileErr && <p className="ai-err">{profileErr}</p>}
              {profile && (
                <p className="hint profile-line">
                  AI profile: {profile.seniority || "—"}
                  {profile.years_experience ? ` · ${profile.years_experience}y` : ""}
                  {profile.summary ? ` — ${profile.summary}` : ""}
                </p>
              )}
              {keywords.length > 0 && (
                <div className="chips">
                  {keywords.slice(0, 24).map((k) => (
                    <button
                      key={k.term}
                      className={`chip${aiKeywords ? " chip-ai" : ""}`}
                      title="Remove"
                      onClick={() => removeKeyword(k.term)}
                    >
                      {k.term} ✕
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Target titles */}
            <section className="card">
              <h3>2 · Target titles (optional)</h3>
              <input
                value={targetTitles}
                onChange={(e) => setTargetTitles(e.target.value)}
                placeholder="Program Manager, Partnerships Lead"
              />
              <p className="hint">Comma-separated. Weighted heavily in ranking.</p>
            </section>

            {/* Companies */}
            <section className="card">
              <h3>3 · Companies ({companies.length})</h3>
              <input
                className="co-search"
                placeholder="Filter companies…"
                value={coFilter}
                onChange={(e) => setCoFilter(e.target.value)}
              />
              {coFilterLc && (
                <p className="hint co-count">
                  {filteredCompanies.length} of {companies.length} shown
                </p>
              )}
              <ul className="co-list">
                {filteredCompanies.map((c) => (
                  <li key={`${c.ats}-${c.slug}`}>
                    <span className="co-name">{c.name}</span>
                    <span className="co-ats">{ADAPTERS[c.ats]?.label}</span>
                    <button
                      className="co-x"
                      aria-label={`Remove ${c.name}`}
                      onClick={() =>
                        setCompanies(
                          companies.filter(
                            (x) => !(x.ats === c.ats && x.slug === c.slug)
                          )
                        )
                      }
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <div className="add-co">
                <input
                  placeholder="Company name"
                  value={newCo.name}
                  onChange={(e) => setNewCo({ ...newCo, name: e.target.value })}
                />
                <div className="add-co-row">
                  <select
                    value={newCo.ats}
                    onChange={(e) => setNewCo({ ...newCo, ats: e.target.value })}
                  >
                    {Object.entries(ADAPTERS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="board slug"
                    value={newCo.slug}
                    onChange={(e) => setNewCo({ ...newCo, slug: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && addCompany()}
                  />
                  <button className="add-btn" onClick={addCompany}>
                    Add
                  </button>
                </div>
                <p className="hint">
                  Slug = the company's board URL ending, e.g. jobs.ashbyhq.com/<b>openai</b>.
                </p>
              </div>
              <div className="wl-actions">
                <button className="wl-btn" onClick={exportWatchlist}>
                  ↓ Export
                </button>
                <input
                  ref={importRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    importWatchlist(e.target.files[0]);
                    e.target.value = "";
                  }}
                />
                <button className="wl-btn" onClick={() => importRef.current.click()}>
                  ↑ Import
                </button>
                <button className="wl-btn" onClick={restoreDefaults}>
                  ↺ Restore default list
                </button>
              </div>
            </section>

            {/* Smart rank */}
            <section className="card">
              <h3>4 · Smart rank</h3>
              <input
                type="password"
                value={aiKey}
                onChange={(e) => setAiKey(e.target.value)}
                placeholder="sk-ant-… Anthropic API key"
                autoComplete="off"
              />
              <label className="sr-slider">
                <span>Candidates: {candidateCount}</span>
                <input
                  type="range"
                  min="20"
                  max="150"
                  step="10"
                  value={candidateCount}
                  onChange={(e) => setCandidateCount(+e.target.value)}
                />
              </label>
              <button
                className="ai-btn"
                onClick={runSmartRank}
                disabled={aiBusy || !aiKey.trim() || !resumeText || !ranked.length}
              >
                {aiBusy
                  ? `Ranking… ${aiProgress[0]}/${aiProgress[1]}`
                  : `Smart rank top ${Math.min(candidateCount, ranked.length || candidateCount)}`}
              </button>
              {aiScores.size > 0 && (
                <button className="wl-btn sr-clear" onClick={clearSmartRank}>
                  Clear AI cache
                </button>
              )}
              {aiError && <p className="ai-err">{aiError}</p>}
              {aiWarnings.map((w, i) => (
                <p className="ai-warn" key={i}>
                  {w}
                </p>
              ))}
              <p className="hint">
                Your key stays in this browser tab (never saved). Calls go directly
                from here to Anthropic, and in this mode your résumé text is sent to
                the Anthropic API to extract your profile and judge fit. Rough cost
                scales with the number of candidates.
              </p>
            </section>
          </aside>

          <main>
            <div className="filters">
              <input
                className="search"
                placeholder="Filter by company, title, location…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={remoteOnly}
                  onChange={(e) => setRemoteOnly(e.target.checked)}
                />
                Remote
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={compOnly}
                  onChange={(e) => setCompOnly(e.target.checked)}
                />
                Has comp
              </label>
              <label className="check" title="Blend a local embedding model into the keyword score. Downloads a ~25MB model once.">
                <input
                  type="checkbox"
                  checked={semBoost}
                  onChange={(e) => setSemBoost(e.target.checked)}
                  disabled={!resumeText || !jobs.length}
                />
                Semantic boost{semBusy ? ` (${semProgress[0]}/${semProgress[1]})` : ""}
              </label>
              <label className="check slider">
                Match ≥ {minMatch}
                <input
                  type="range"
                  min="0"
                  max="80"
                  step="10"
                  value={minMatch}
                  onChange={(e) => setMinMatch(+e.target.value)}
                />
              </label>
            </div>

            {semWarn && <div className="errors sem-warn">{semWarn}</div>}

            {errors.length > 0 && (
              <div className="errors">
                <button
                  className="errors-toggle"
                  onClick={() => setErrorsOpen((o) => !o)}
                  aria-expanded={errorsOpen}
                >
                  {errorsOpen ? "▾" : "▸"} {errors.length} board
                  {errors.length === 1 ? "" : "s"} failed
                </button>
                {errorsOpen &&
                  errors.map((e, i) => (
                    <span key={i} className="errors-detail">
                      {e.company} ({e.ats}): {e.message}
                    </span>
                  ))}
              </div>
            )}

            <div className="results-head">
              <h2>
                {jobs.length
                  ? `${visible.length} of ${jobs.length} roles`
                  : "No scan yet"}
              </h2>
              {scannedAt && <span className="stamp">last scan {scannedAt.toLocaleTimeString()}</span>}
            </div>

            {!jobs.length && !scanning && (
              <div className="empty">
                Upload your resume, then hit <b>Scan all boards</b>. Roles appear here
                ranked by fit.
              </div>
            )}

            {shown.map((j) => {
              const preview = (j.description || "").replace(/\s+/g, " ").trim();
              const isOpen = expanded === j.id;
              return (
                <article className="job" key={j.id}>
                  <div className="job-head">
                    <div>
                      <div className="job-co">
                        {j.company}
                        <span className="job-src">{j.source}</span>
                      </div>
                      <h4 className="job-title">{j.title}</h4>
                      {j.ai && j.ai.reason && (
                        <p className="ai-reason">{j.ai.reason}</p>
                      )}
                      <div className="job-meta">
                        {j.location && <span>{j.location}</span>}
                        {j.remote && <span className="tag-remote">Remote</span>}
                        {j.postedAt && <span>{timeAgo(j.postedAt)}</span>}
                      </div>
                    </div>
                    <div className="job-right">
                      {j.ai ? (
                        <>
                          <div className="ai-score" title="Smart-rank fit score">
                            {j.ai.score}
                          </div>
                          {hasScores && (
                            <div className="match match-mini" title="Keyword score">
                              {j.match}
                            </div>
                          )}
                        </>
                      ) : (
                        hasScores && (
                          <div className="match" title="Keyword score">
                            {j.match}
                          </div>
                        )
                      )}
                      {j.comp && <div className="comp">{j.comp}</div>}
                    </div>
                  </div>
                  {preview && (
                    <>
                      {isOpen ? (
                        <p className="job-desc job-desc-full">
                          {(j.description || "").slice(0, 3000)}
                        </p>
                      ) : (
                        <p className="job-desc">
                          {preview.slice(0, 220)}
                          {preview.length > 220 ? "…" : ""}
                        </p>
                      )}
                      {preview.length > 220 && (
                        <button
                          className="more"
                          onClick={() => setExpanded(isOpen ? null : j.id)}
                        >
                          {isOpen ? "show less" : "show more"}
                        </button>
                      )}
                    </>
                  )}
                  <a className="apply" href={j.url} target="_blank" rel="noreferrer">
                    View posting ↗
                  </a>
                </article>
              );
            })}
          </main>
        </div>
      </div>
    </>
  );
}
