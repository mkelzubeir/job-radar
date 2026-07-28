import { useEffect, useMemo, useRef, useState } from "react";
import { ADAPTERS, scanCompanies } from "./lib/ats";
import { extractResumeText, extractKeywords } from "./lib/resume";
import { rankJobs } from "./lib/match";
import seedCompanies from "./data/companies.json";

const LS = {
  companies: "jobradar.companies",
  keywords: "jobradar.keywords",
  titles: "jobradar.titles",
};
const load = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};

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
  const [companies, setCompanies] = useState(() => load(LS.companies, seedCompanies));
  const [keywords, setKeywords] = useState(() => load(LS.keywords, []));
  const [targetTitles, setTargetTitles] = useState(() => load(LS.titles, ""));
  const [resumeName, setResumeName] = useState("");
  const [jobs, setJobs] = useState([]);
  const [errors, setErrors] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState([0, 0]);
  const [scannedAt, setScannedAt] = useState(null);

  // Filters
  const [q, setQ] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [compOnly, setCompOnly] = useState(false);
  const [minMatch, setMinMatch] = useState(0);
  const [expanded, setExpanded] = useState(null);

  // Add-company form
  const [newCo, setNewCo] = useState({ name: "", ats: "ashby", slug: "" });
  const fileRef = useRef(null);

  useEffect(() => localStorage.setItem(LS.companies, JSON.stringify(companies)), [companies]);
  useEffect(() => localStorage.setItem(LS.keywords, JSON.stringify(keywords)), [keywords]);
  useEffect(() => localStorage.setItem(LS.titles, JSON.stringify(targetTitles)), [targetTitles]);

  async function onResume(file) {
    if (!file) return;
    setResumeName(file.name);
    try {
      const text = await extractResumeText(file);
      setKeywords(extractKeywords(text));
    } catch (e) {
      setErrors((prev) => [...prev, { company: "Resume", ats: "-", message: e.message }]);
    }
  }

  async function scan() {
    setScanning(true);
    setErrors([]);
    setProgress([0, companies.length]);
    const { jobs: found, errors: errs } = await scanCompanies(companies, (d, t) =>
      setProgress([d, t])
    );
    setJobs(found);
    setErrors(errs);
    setScannedAt(new Date());
    setScanning(false);
  }

  const titlesArr = targetTitles.split(",").map((s) => s.trim()).filter(Boolean);
  const ranked = useMemo(
    () => rankJobs(jobs, keywords, titlesArr),
    [jobs, keywords, targetTitles] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const visible = ranked.filter((j) => {
    if (remoteOnly && !j.remote) return false;
    if (compOnly && !j.comp) return false;
    if (j.match < minMatch) return false;
    if (q) {
      const hay = `${j.company} ${j.title} ${j.location}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
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
              across five ATS platforms, and get every open role ranked against you.
              Everything runs in your browser.
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
              <p className="hint">
                Parsed locally with pdf.js — your resume never leaves this device.
              </p>
              {keywords.length > 0 && (
                <div className="chips">
                  {keywords.slice(0, 24).map((k) => (
                    <button
                      key={k.term}
                      className="chip"
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
              <h3>2 · Target titles</h3>
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
              <ul className="co-list">
                {companies.map((c, i) => (
                  <li key={`${c.ats}-${c.slug}-${i}`}>
                    <span className="co-name">{c.name}</span>
                    <span className="co-ats">{ADAPTERS[c.ats]?.label}</span>
                    <button
                      className="co-x"
                      aria-label={`Remove ${c.name}`}
                      onClick={() => setCompanies(companies.filter((_, j) => j !== i))}
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

            {errors.length > 0 && (
              <div className="errors">
                {errors.map((e, i) => (
                  <span key={i}>
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

            {visible.map((j) => (
              <article className="job" key={j.id}>
                <div className="job-head">
                  <div>
                    <div className="job-co">
                      {j.company}
                      <span className="job-src">{j.source}</span>
                    </div>
                    <h4 className="job-title">{j.title}</h4>
                    <div className="job-meta">
                      {j.location && <span>{j.location}</span>}
                      {j.remote && <span className="tag-remote">Remote</span>}
                      {j.postedAt && <span>{timeAgo(j.postedAt)}</span>}
                    </div>
                  </div>
                  <div className="job-right">
                    {keywords.length + titlesArr.length > 0 && (
                      <div className="match" title="Resume match score">
                        {j.match}
                      </div>
                    )}
                    {j.comp && <div className="comp">{j.comp}</div>}
                  </div>
                </div>
                {j.description && (
                  <p className="job-desc">
                    {expanded === j.id
                      ? j.description.slice(0, 1500)
                      : j.description.slice(0, 220) +
                        (j.description.length > 220 ? "…" : "")}
                    {j.description.length > 220 && (
                      <button
                        className="more"
                        onClick={() => setExpanded(expanded === j.id ? null : j.id)}
                      >
                        {expanded === j.id ? "less" : "more"}
                      </button>
                    )}
                  </p>
                )}
                <a className="apply" href={j.url} target="_blank" rel="noreferrer">
                  View posting ↗
                </a>
              </article>
            ))}
          </main>
        </div>
      </div>
    </>
  );
}
