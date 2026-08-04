import { useEffect, useMemo, useRef, useState } from "react";
import { ADAPTERS, scanCompanies } from "./lib/ats";
import { extractResumeText, extractKeywords } from "./lib/resume";
import { rankJobs } from "./lib/match";
import { semanticRank, clearAiCache, extractProfile } from "./lib/ai";
import {
  deepScan,
  buildPool,
  estimateCost,
  clearDeepScanCache,
  deepScanCSV,
} from "./lib/deepscan";
import seedCompanies from "./data/companies.json";
import { saveScan, loadScan, clearScan } from "./lib/store";
import {
  enrichJob,
  jobPassesFilters,
  countActiveFilters,
  DEFAULT_FILTERS,
  CATEGORY_ORDER,
  SENIORITY_ORDER,
} from "./lib/filters";

const LS = {
  companies: "jobradar.companies",
  keywords: "jobradar.keywords",
  titles: "jobradar.titles",
  resumeText: "jobradar.resumeText",
  seedVersion: "jobradar.seedVersion",
  candidates: "jobradar.candidateCount",
  filters: "jobradar.filters",
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

// --- US location classifier -------------------------------------------------
// Job locations are free text (e.g. "San Francisco, CA", "Remote - US",
// "London, UK", "Toronto, ON, Canada"). This is a pragmatic heuristic, tuned
// for precision (better to drop an ambiguous role than show a non-US one).
const US_STATE_ABBR = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(
    " "
  )
);
const US_STATE_NAMES = [
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware",
  "florida","georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky",
  "louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi","missouri",
  "montana","nebraska","nevada","new hampshire","new jersey","new mexico","new york",
  "north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island",
  "south carolina","south dakota","tennessee","texas","utah","vermont","virginia","washington",
  "west virginia","wisconsin","wyoming","district of columbia",
];
const NON_US_RE =
  /\b(canada|canadian|united kingdom|uk|u\.k\.|britain|england|scotland|wales|ireland|germany|france|spain|italy|netherlands|portugal|poland|romania|sweden|norway|denmark|finland|switzerland|austria|belgium|czech|slovakia|greece|hungary|bulgaria|croatia|serbia|india|china|japan|korea|singapore|hong kong|taiwan|australia|new zealand|brazil|mexico|argentina|chile|colombia|peru|uruguay|israel|turkey|egypt|morocco|nigeria|kenya|ghana|south africa|uae|united arab emirates|dubai|abu dhabi|saudi|qatar|bahrain|kuwait|philippines|indonesia|thailand|vietnam|malaysia|pakistan|bangladesh|sri lanka|ukraine|russia|estonia|latvia|lithuania|slovenia|luxembourg|iceland|emea|apac|latam|europe)\b/;

function isUSJob(job) {
  const loc = (job.location || "").trim();
  if (!loc) return false; // no location (incl. bare "Remote") — can't confirm US
  const lc = loc.toLowerCase();

  // Explicit US markers first (win over everything).
  if (/\bunited states\b/.test(lc) || /\busa\b/.test(lc) || /u\.s\.?a?\.?/.test(lc)) return true;

  // SmartRecruiters encodes the country as an uppercased ISO code at the end
  // ("New York, US" vs "Toronto, CA" = Canada), so trust only an explicit US.
  if (job.source === "SmartRecruiters") return /,\s*US\b/.test(loc);

  // Any explicit non-US country/region → not US.
  if (NON_US_RE.test(lc)) return false;

  // Standalone "US" token (", US", "US Remote", "(US)").
  if (/\bus\b/.test(lc)) return true;
  // Full US state name.
  if (US_STATE_NAMES.some((s) => lc.includes(s))) return true;
  // "City, ST" two-letter US state abbreviation.
  const m = loc.match(/,\s*([A-Z]{2})\b/);
  if (m && US_STATE_ABBR.has(m[1])) return true;

  return false;
}

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

  // Deep Scan — the maximum-quality, expensive cascade.
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepProg, setDeepProg] = useState(null); // { stage, label, done, total }
  const [deepResults, setDeepResults] = useState(null); // { ranked, warnings, stats }
  const [deepError, setDeepError] = useState(null);

  // Semantic boost (Stage 2) — optional local embeddings, no API key.
  const [semBoost, setSemBoost] = useState(false);
  const [semScores, setSemScores] = useState(() => new Map());
  const [semBusy, setSemBusy] = useState(false);
  const [semProgress, setSemProgress] = useState([0, 0]);
  const [semWarn, setSemWarn] = useState(null);
  const embedCacheRef = useRef(new Map());

  // Filters
  const [q, setQ] = useState("");
  const [usOnly, setUsOnly] = useState(true); // default: US-only
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [compOnly, setCompOnly] = useState(false);
  const [minMatch, setMinMatch] = useState(0);
  const [expanded, setExpanded] = useState(null);

  // Advanced filters — persisted so they survive refreshes along with the scan.
  const [flt, setFlt] = useState(() => ({
    ...DEFAULT_FILTERS,
    ...load(LS.filters, {}),
  }));
  const [fltOpen, setFltOpen] = useState(false);
  useEffect(() => save(LS.filters, flt), [flt]);

  // Scan persistence: jobs first seen in the latest scan + restore marker.
  const [newIds, setNewIds] = useState(() => new Set());
  const [restored, setRestored] = useState(false);

  // On load, restore the last saved scan from IndexedDB so filtering works
  // immediately without rescanning 549 boards.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await loadScan();
      if (cancelled || !s?.jobs?.length) return;
      setJobs((cur) => (cur.length ? cur : s.jobs));
      setScannedAt(s.scannedAt ? new Date(s.scannedAt) : null);
      setNewIds(new Set(s.newIds || []));
      if (Array.isArray(s.errors) && s.errors.length) setErrors(s.errors);
      setRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

    // Persist the whole scan to IndexedDB so it survives refresh and can be
    // re-filtered without rescanning. firstSeen carries over across scans so
    // "New" means new-to-you, not just present-in-this-scan.
    const prev = await loadScan();
    const nowIso = new Date().toISOString();
    const prevFirstSeen = prev?.firstSeen || {};
    const firstSeen = {};
    const freshIds = [];
    for (const j of acc) {
      const seen = prevFirstSeen[j.id] || nowIso;
      firstSeen[j.id] = seen;
      if (prev && seen === nowIso) freshIds.push(j.id);
    }
    setNewIds(new Set(freshIds));
    setScannedAt(new Date(nowIso));
    setRestored(false);
    saveScan({
      jobs: acc,
      scannedAt: nowIso,
      errors: errs,
      firstSeen,
      newIds: freshIds,
    });

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

  // Enrich every scanned job once: role category, seniority, parsed years of
  // experience, comp ceiling. Everything downstream filters on these.
  const enriched = useMemo(() => jobs.map(enrichJob), [jobs]);

  // Per-category / per-seniority counts shown on the filter chips.
  const catCounts = useMemo(() => {
    const m = new Map();
    for (const j of enriched) m.set(j.category, (m.get(j.category) || 0) + 1);
    return m;
  }, [enriched]);
  const senCounts = useMemo(() => {
    const m = new Map();
    for (const j of enriched) m.set(j.seniority, (m.get(j.seniority) || 0) + 1);
    return m;
  }, [enriched]);

  // Stage 1 (retrieval): TF-IDF over the whole scan.
  const ranked = useMemo(
    () => rankJobs(enriched, keywords, titlesArr),
    [enriched, keywords, targetTitles] // eslint-disable-line react-hooks/exhaustive-deps
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

  // IDs shown in the Deep Scan tiers — excluded from the keyword list below so
  // a job isn't rendered twice.
  const deepIds = useMemo(
    () => new Set((deepResults?.ranked || []).map((r) => r.id)),
    [deepResults]
  );

  const visible = withAi.filter((j) => {
    if (deepIds.has(String(j.id))) return false; // already in the Deep Scan tiers
    if (usOnly && !isUSJob(j)) return false;
    if (remoteOnly && !j.remote) return false;
    if (compOnly && !j.comp) return false;
    if (primaryScore(j) < minMatch) return false; // filter on whichever score is primary
    if (!jobPassesFilters(j, flt, newIds)) return false;
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

  // Tri-state chip cycle: neutral → include → exclude → neutral.
  const cycleChip = (field, key) =>
    setFlt((f) => {
      const m = { ...(f[field] || {}) };
      const next = (m[key] || 0) === 0 ? 1 : m[key] === 1 ? -1 : 0;
      if (next === 0) delete m[key];
      else m[key] = next;
      return { ...f, [field]: m };
    });
  const setF = (patch) => setFlt((f) => ({ ...f, ...patch }));
  const nActiveFilters = countActiveFilters(flt);
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
    clearDeepScanCache();
    setAiScores(new Map());
    setAiWarnings([]);
    setAiError(null);
    setProfile(null);
    setDeepResults(null);
    setDeepError(null);
  }

  // The profile Deep Scan reasons over — the AI profile if extracted, else a
  // minimal one seeded from the user's target-titles field.
  const dsProfile =
    profile || (titlesArr.length ? { titles: titlesArr } : null);

  // Attach embedding scores (if a Semantic boost ran) so Stage 0 can union them.
  const jobsForDeep = semScores.size
    ? ranked.map((j) => ({ ...j, sem: semScores.get(j.id) }))
    : ranked;

  async function runDeepScan() {
    const key = aiKey.trim();
    if (!key) {
      setDeepError("Enter your Anthropic API key below first.");
      return;
    }
    if (!resumeText.trim() || !ranked.length || deepBusy) return;

    const pool = buildPool(jobsForDeep, dsProfile);
    const est = estimateCost(pool.length);
    const ok = window.confirm(
      `Deep Scan runs a 3-stage Claude cascade (screen → deep read → tournament) over ~${pool.length} candidate jobs.\n\n` +
        `This is the maximum-quality, most EXPENSIVE option.\n\n` +
        `Rough estimate: ~$${est.usd.toFixed(2)} ` +
        `(~${Math.round(est.inTok / 1000)}k input / ${Math.round(est.outTok / 1000)}k output tokens, ` +
        `cached so re-runs only pay for what's new).\n\nProceed?`
    );
    if (!ok) return;

    setDeepBusy(true);
    setDeepError(null);
    setDeepResults(null);
    setDeepProg(null);
    try {
      const res = await deepScan(resumeText, dsProfile, jobsForDeep, key, (p) =>
        setDeepProg(p)
      );
      setDeepResults(res);
    } catch (e) {
      console.error("Deep Scan failed:", e);
      setDeepError(humanizeAiError(e));
    } finally {
      setDeepBusy(false);
    }
  }

  function downloadShortlist() {
    if (!deepResults?.ranked?.length) return;
    const blob = new Blob([deepScanCSV(deepResults.ranked)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "job-radar-shortlist.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const hasScores = keywords.length + titlesArr.length > 0;

  const DEEP_TIERS = [
    { key: "apply_now", label: "Apply now" },
    { key: "strong", label: "Strong" },
    { key: "worth_a_look", label: "Worth a look" },
  ];
  const COMP_LABEL = { above: "comp: above", within: "comp: within", below: "comp: below", unknown: "comp: n/a" };

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

              <div className="deep-block">
                <div className="deep-title">
                  Deep Scan <span className="deep-badge">max quality</span>
                </div>
                <button
                  className="ai-btn deep-btn"
                  onClick={runDeepScan}
                  disabled={deepBusy || !aiKey.trim() || !resumeText || !ranked.length}
                  title={aiKey.trim() ? "" : "Enter your Anthropic API key above first"}
                >
                  {deepBusy ? (
                    <>
                      <span className="spinner" aria-hidden="true" />{" "}
                      {deepProg ? `${deepProg.label} ${deepProg.done}/${deepProg.total}…` : "Starting…"}
                    </>
                  ) : (
                    "Run Deep Scan"
                  )}
                </button>
                {deepResults?.ranked?.length > 0 && (
                  <button className="wl-btn sr-clear" onClick={downloadShortlist}>
                    ↓ Download shortlist (CSV)
                  </button>
                )}
                {deepError && <p className="ai-err">{deepError}</p>}
                <p className="hint">
                  A 3-stage cascade — screen → deep read → tournament — over a wide
                  candidate pool. The maximum-quality, most expensive path; you'll
                  see a cost estimate and confirm before it runs. Results cache
                  locally, so re-runs only pay for what's new.
                </p>
              </div>
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
              <label className="check" title="Show only jobs located in the United States">
                <input
                  type="checkbox"
                  checked={usOnly}
                  onChange={(e) => setUsOnly(e.target.checked)}
                />
                US only
              </label>
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
              <button
                className={"flt-toggle" + (nActiveFilters ? " active" : "")}
                onClick={() => setFltOpen((o) => !o)}
                aria-expanded={fltOpen}
              >
                {fltOpen ? "▾" : "▸"} Filters
                {nActiveFilters ? ` · ${nActiveFilters}` : ""}
              </button>
            </div>

            {fltOpen && (
              <div className="filter-panel">
                <div className="fp-group">
                  <span className="fp-label">
                    Role type <em>click once to include only, twice to exclude</em>
                  </span>
                  <div className="fp-chips">
                    {CATEGORY_ORDER.map((c) => {
                      const n = catCounts.get(c) || 0;
                      const st = flt.categories?.[c] || 0;
                      return (
                        <button
                          key={c}
                          className={
                            "fchip" + (st === 1 ? " inc" : st === -1 ? " exc" : "")
                          }
                          onClick={() => cycleChip("categories", c)}
                          title={
                            st === 1
                              ? "Included — click to exclude"
                              : st === -1
                              ? "Excluded — click to clear"
                              : "Click to include only this type"
                          }
                        >
                          {st === -1 ? "✕ " : st === 1 ? "✓ " : ""}
                          {c}
                          {jobs.length ? <b>{n}</b> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="fp-group">
                  <span className="fp-label">Seniority</span>
                  <div className="fp-chips">
                    {SENIORITY_ORDER.map(([key, label]) => {
                      const n = senCounts.get(key) || 0;
                      const st = flt.seniorities?.[key] || 0;
                      return (
                        <button
                          key={key}
                          className={
                            "fchip" + (st === 1 ? " inc" : st === -1 ? " exc" : "")
                          }
                          onClick={() => cycleChip("seniorities", key)}
                        >
                          {st === -1 ? "✕ " : st === 1 ? "✓ " : ""}
                          {label}
                          {jobs.length ? <b>{n}</b> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="fp-row">
                  <label className="check slider fp-years">
                    Experience required ≤{" "}
                    {flt.maxYears > 0 ? `${flt.maxYears} yrs` : "any"}
                    <input
                      type="range"
                      min="0"
                      max="10"
                      value={flt.maxYears}
                      onChange={(e) => setF({ maxYears: +e.target.value })}
                    />
                  </label>
                  {flt.maxYears > 0 && (
                    <label
                      className="check"
                      title="Roles whose description states no years requirement. Titles still imply years: Senior ≈ 5, Staff/Principal ≈ 8, Director ≈ 10."
                    >
                      <input
                        type="checkbox"
                        checked={flt.includeUnknownYears}
                        onChange={(e) =>
                          setF({ includeUnknownYears: e.target.checked })
                        }
                      />
                      keep roles that don't state years
                    </label>
                  )}
                </div>

                <div className="fp-row">
                  <label className="check slider">
                    Comp reaches ≥{" "}
                    {flt.minCompK > 0 ? `$${flt.minCompK}k` : "any"}
                    <input
                      type="range"
                      min="0"
                      max="300"
                      step="10"
                      value={flt.minCompK}
                      onChange={(e) => setF({ minCompK: +e.target.value })}
                    />
                  </label>
                  <label className="check">
                    Posted within
                    <select
                      className="fp-select"
                      value={flt.postedDays}
                      onChange={(e) => setF({ postedDays: +e.target.value })}
                    >
                      <option value={0}>any time</option>
                      <option value={7}>7 days</option>
                      <option value={14}>14 days</option>
                      <option value={30}>30 days</option>
                    </select>
                  </label>
                  <label
                    className="check"
                    title="Only roles that appeared for the first time in your latest scan"
                  >
                    <input
                      type="checkbox"
                      checked={flt.newOnly}
                      disabled={!newIds.size}
                      onChange={(e) => setF({ newOnly: e.target.checked })}
                    />
                    New since last scan{newIds.size ? ` (${newIds.size})` : ""}
                  </label>
                </div>

                <div className="fp-row">
                  <input
                    className="fp-input"
                    placeholder="Exclude title words — e.g. engineer, scientist"
                    value={flt.excludeWords}
                    onChange={(e) => setF({ excludeWords: e.target.value })}
                  />
                  <input
                    className="fp-input"
                    placeholder="Must mention — e.g. human data, rlhf"
                    value={flt.mustWords}
                    onChange={(e) => setF({ mustWords: e.target.value })}
                  />
                  <button
                    className="wl-btn"
                    onClick={() => setFlt({ ...DEFAULT_FILTERS })}
                    disabled={!nActiveFilters}
                  >
                    Reset filters
                  </button>
                </div>
              </div>
            )}

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

            {deepResults?.ranked?.length > 0 && (
              <section className="deep-results">
                <div className="results-head">
                  <h2>Deep Scan shortlist</h2>
                  <span className="stamp">
                    {deepResults.stats.pool} screened · {deepResults.stats.deep} deep-read ·{" "}
                    {deepResults.ranked.length} ranked
                  </span>
                </div>
                {deepResults.warnings.map((w, i) => (
                  <p className="ai-warn" key={i}>
                    {w}
                  </p>
                ))}
                {DEEP_TIERS.map(({ key, label }) => {
                  const rows = deepResults.ranked.filter(
                    (r) => r.tier === key && (!usOnly || isUSJob(r))
                  );
                  if (!rows.length) return null;
                  return (
                    <div className="deep-tier" key={key}>
                      <h3 className={`deep-tier-h deep-tier-${key}`}>
                        {label} <span className="deep-tier-n">{rows.length}</span>
                      </h3>
                      {rows.map((r) => (
                        <article className="job ds-card" key={r.id}>
                          <div className="job-head">
                            <div>
                              <div className="job-co">
                                <span className="ds-rank">#{r.rank}</span>
                                {r.company}
                                <span className="job-src">{r.source}</span>
                              </div>
                              <h4 className="job-title">{r.title}</h4>
                              {r.apply_angle && (
                                <p className="ds-angle">{r.apply_angle}</p>
                              )}
                              <div className="job-meta">
                                {r.location && <span>{r.location}</span>}
                                {r.remote && <span className="tag-remote">Remote</span>}
                                <span className={`ds-comp ds-comp-${r.comp_check}`}>
                                  {COMP_LABEL[r.comp_check]}
                                </span>
                              </div>
                            </div>
                            <div className="job-right">
                              <div className="ai-score" title="Deep Scan fit score">
                                {r.score}
                              </div>
                              {r.comp && <div className="comp">{r.comp}</div>}
                            </div>
                          </div>
                          {r.fit_reasons.length > 0 && (
                            <ul className="ds-fit">
                              {r.fit_reasons.map((f, i) => (
                                <li key={i}>{f}</li>
                              ))}
                            </ul>
                          )}
                          {r.gaps.length > 0 && (
                            <p className="ds-gaps">Gaps: {r.gaps.join(" · ")}</p>
                          )}
                          <a className="apply" href={r.url} target="_blank" rel="noreferrer">
                            View posting ↗
                          </a>
                        </article>
                      ))}
                    </div>
                  );
                })}
              </section>
            )}

            <div className="results-head">
              <h2>
                {jobs.length
                  ? deepResults?.ranked?.length
                    ? `${visible.length} more, keyword-ranked`
                    : `${visible.length} of ${jobs.length} roles`
                  : "No scan yet"}
              </h2>
              {scannedAt && (
                <span className="stamp">
                  {restored
                    ? `saved scan · ${timeAgo(scannedAt.toISOString())}`
                    : `last scan ${scannedAt.toLocaleTimeString()}`}
                  {restored && (
                    <button
                      className="stamp-clear"
                      title="Delete the saved scan from this browser"
                      onClick={async () => {
                        await clearScan();
                        setJobs([]);
                        setNewIds(new Set());
                        setScannedAt(null);
                        setRestored(false);
                        setErrors([]);
                      }}
                    >
                      clear
                    </button>
                  )}
                </span>
              )}
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
                        {newIds.has(j.id) && <span className="tag-new">New</span>}
                        {j.location && <span>{j.location}</span>}
                        {j.remote && <span className="tag-remote">Remote</span>}
                        {j.postedAt && <span>{timeAgo(j.postedAt)}</span>}
                        <span className="tag-cat">{j.category}</span>
                        {j.seniority !== "mid" && (
                          <span className="tag-cat">{j.seniorityLabel}</span>
                        )}
                        {j.reqYears != null ? (
                          <span
                            className="tag-yrs"
                            title="Years of experience the description asks for"
                          >
                            {j.reqYears}+ yrs
                          </span>
                        ) : (
                          j.effYears != null && (
                            <span
                              className="tag-yrs tag-yrs-inferred"
                              title="No years stated — inferred from the title's seniority"
                            >
                              ~{j.effYears} yrs
                            </span>
                          )
                        )}
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
