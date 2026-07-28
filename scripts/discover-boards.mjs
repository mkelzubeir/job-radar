#!/usr/bin/env node
/**
 * Build-time company discovery. Gathers candidate companies from public sources,
 * probes their ATS APIs live, and writes every verified board (>0 open jobs)
 * into src/data/companies.json. This is a MAINTAINER tool — the app ships the
 * static verified JSON it produces, and never runs discovery at runtime.
 *
 *   node scripts/discover-boards.mjs                 # full run
 *   node scripts/discover-boards.mjs --limit 200     # probe first 200 candidates
 *   node scripts/discover-boards.mjs --dry           # don't write, just report
 *
 * Sources:
 *   - YC company directory (yc-oss/api) — thousands of names + domains.
 *   - Public GitHub lists that embed jobs.ashbyhq.com/X, boards.greenhouse.io/X,
 *     jobs.lever.co/X, {slug}.recruitee.com, {slug}.breezy.hr URLs.
 *   - A small curated set of verified boards on the newer adapters (recruitee,
 *     breezy) that the YC set doesn't cover.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "src", "data", "companies.json");

const argv = process.argv.slice(2);
const LIMIT = (() => {
  const i = argv.indexOf("--limit");
  return i >= 0 ? parseInt(argv[i + 1], 10) : Infinity;
})();
const DRY = argv.includes("--dry");

const CONCURRENCY = 12;
const TIMEOUT_MS = 9000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";

const YC_URL = "https://raw.githubusercontent.com/yc-oss/api/main/companies/all.json";
const GH_LISTS = [
  "https://raw.githubusercontent.com/poteto/hiring-without-whiteboards/main/README.md",
];

// Verified live (see scripts probing) on the newer adapters; YC rarely covers these.
const CURATED = [
  { name: "bunq", ats: "recruitee", slug: "bunq" },
  { name: "Adjust", ats: "recruitee", slug: "adjust" },
  { name: "Census", ats: "breezy", slug: "census" },
  { name: "Cortex", ats: "breezy", slug: "cortex" },
];

// ---- endpoints + job counting (mirrors src/lib/ats.js shapes) --------------
const ENDPOINTS = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  lever: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
  recruitee: (s) => `https://${s}.recruitee.com/api/offers/`,
  breezy: (s) => `https://${s}.breezy.hr/json`,
};
const countJobs = (ats, ct, d) => {
  if (!d) return 0;
  switch (ats) {
    case "lever":
      return Array.isArray(d) ? d.length : 0;
    case "recruitee":
      return d.offers?.length || 0;
    case "breezy":
      // non-customers get served marketing HTML; require a JSON array body
      return ct.includes("json") && Array.isArray(d) ? d.length : 0;
    default:
      return d.jobs?.length || 0; // ashby, greenhouse
  }
};

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": UA },
    });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) return { status: r.status, ct, data: null };
    const data = ct.includes("json") ? await r.json().catch(() => null) : null;
    return { status: r.status, ct, data };
  } finally {
    clearTimeout(t);
  }
}

// One probe with a single retry on network error / timeout (not on HTTP status).
async function probe(ats, slug) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { status, ct, data } = await fetchJson(ENDPOINTS[ats](slug));
      if (status !== 200) return 0;
      return countJobs(ats, ct, data);
    } catch {
      if (attempt === 1) return 0;
    }
  }
  return 0;
}

// ---- slug generation --------------------------------------------------------
const clean = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const dashed = (s) => (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const domainOf = (w) => {
  try {
    return new URL(w).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return null;
  }
};
function slugGuesses(c) {
  const g = new Set();
  if (c.slug) g.add(c.slug);
  const dom = domainOf(c.website);
  if (dom) g.add(dom);
  g.add(clean(c.name));
  g.add(dashed(c.name));
  return [...g].filter((s) => s && s.length > 1).slice(0, 4);
}

// First verified hit wins. YC companies live on the big-3 ATS almost exclusively,
// so we only probe ashby/greenhouse/lever here (recruitee/breezy come from lists).
async function discoverCompany(c) {
  const slugs = slugGuesses(c);
  for (const slug of slugs) {
    for (const ats of ["ashby", "greenhouse", "lever"]) {
      const n = await probe(ats, slug);
      if (n > 0) return { name: c.name, ats, slug, jobCount: n };
    }
  }
  return null;
}

async function pool(items, size, fn, onTick) {
  const out = new Array(items.length);
  let i = 0;
  let done = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      onTick?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// ---- source gathering -------------------------------------------------------
async function fetchYC() {
  try {
    const d = await (await fetch(YC_URL)).json();
    // Actively-hiring companies are the highest-signal candidates.
    return d.filter((c) => c.isHiring && c.website).map((c) => ({ name: c.name, slug: c.slug, website: c.website }));
  } catch (e) {
    console.warn("! YC source failed:", e.message);
    return [];
  }
}

async function fetchGithubPairs() {
  const re =
    /(jobs\.ashbyhq\.com|boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.lever\.co|([a-z0-9-]+)\.recruitee\.com|([a-z0-9-]+)\.breezy\.hr)\/([A-Za-z0-9_-]+)/g;
  const pairs = [];
  for (const url of GH_LISTS) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const text = await r.text();
      let m;
      while ((m = re.exec(text))) {
        const host = m[1];
        if (host.includes("ashbyhq")) pairs.push({ ats: "ashby", slug: m[4] });
        else if (host.includes("greenhouse")) pairs.push({ ats: "greenhouse", slug: m[4] });
        else if (host.includes("lever")) pairs.push({ ats: "lever", slug: m[4] });
        else if (host.includes("recruitee")) pairs.push({ ats: "recruitee", slug: m[2] });
        else if (host.includes("breezy")) pairs.push({ ats: "breezy", slug: m[3] });
      }
    } catch {
      /* best-effort */
    }
  }
  return pairs;
}

// ---- main -------------------------------------------------------------------
const titleCase = (s) =>
  s.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

async function main() {
  const existing = JSON.parse(await readFile(DATA, "utf8"));
  console.log(`Loaded ${existing.length} existing verified companies.`);

  const yc = await fetchYC();
  console.log(`YC candidates (hiring): ${yc.length}`);
  const ghPairs = await fetchGithubPairs();
  console.log(`GitHub list ATS pairs: ${ghPairs.length}`);

  const candidates = yc.slice(0, LIMIT);
  console.log(`\nProbing ${candidates.length} YC candidates across ashby/greenhouse/lever…`);
  let last = 0;
  const found = (
    await pool(candidates, CONCURRENCY, discoverCompany, (d, t) => {
      if (d - last >= 50 || d === t) {
        process.stdout.write(`\r  ${d}/${t}   `);
        last = d;
      }
    })
  ).filter(Boolean);
  process.stdout.write("\n");
  console.log(`YC verified hits: ${found.length}`);

  // Verify GitHub-list pairs + curated extras (these carry no job count yet).
  const toVerify = [...ghPairs, ...CURATED];
  console.log(`\nVerifying ${toVerify.length} list/curated boards…`);
  const listVerified = (
    await pool(toVerify, CONCURRENCY, async (p) => {
      const n = await probe(p.ats, p.slug);
      return n > 0 ? { name: p.name || titleCase(p.slug), ats: p.ats, slug: p.slug, jobCount: n } : null;
    })
  ).filter(Boolean);
  console.log(`List/curated verified: ${listVerified.length}`);

  // Merge: existing seed (authoritative names) wins, then discovered, deduped.
  const byKey = new Map();
  const key = (c) => `${c.ats}:${c.slug}`.toLowerCase();
  for (const c of existing) byKey.set(key(c), { name: c.name, ats: c.ats, slug: c.slug });
  for (const c of [...found, ...listVerified]) {
    if (!byKey.has(key(c))) byKey.set(key(c), { name: c.name, ats: c.ats, slug: c.slug });
  }

  const merged = [...byKey.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );

  // Per-ATS summary.
  const counts = {};
  for (const c of merged) counts[c.ats] = (counts[c.ats] || 0) + 1;
  console.log("\n=== Final companies.json ===");
  console.log(`Total: ${merged.length}  (was ${existing.length})`);
  for (const [ats, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ats.padEnd(16)} ${n}`);
  }

  if (DRY) {
    console.log("\n--dry: not writing companies.json");
    return;
  }
  await writeFile(DATA, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\nWrote ${merged.length} companies to src/data/companies.json`);
  console.log("Next: run `npm run verify` to confirm the written list is 100% green.");
}

main();
