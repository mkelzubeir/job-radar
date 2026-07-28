/**
 * Deep Scan — a maximum-quality, deliberately expensive ranking cascade for a
 * single user willing to spend API credits. Everything runs as direct browser
 * calls to the Anthropic API (no backend), the key never leaves the tab.
 *
 * Cascade:
 *   Stage 0  build a wide candidate pool (cheap, local)
 *   Stage 1  LLM screen — score the whole pool cheaply, keep top 150
 *   Stage 2  deep read — full descriptions + full résumé, keep the survivors
 *   Stage 3  tournament — comparatively rank the top 30 for THIS candidate
 *
 * Stage outputs are cached in localStorage by résumé-hash + job id so an
 * interrupted or re-run Deep Scan only pays for what's new.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
// Aligned with src/lib/ai.js — the whole app uses Sonnet 5.
const MODEL = "claude-sonnet-5";

const CACHE = {
  screen: "jobradar.ds.screen",
  deep: "jobradar.ds.deep",
  tourn: "jobradar.ds.tourn",
};

const POOL_EACH = 1500; // per-signal cap in Stage 0
const SCREEN_KEEP = 150; // survivors after Stage 1
const TOURNAMENT_KEEP = 30; // finalists into Stage 3

// ---- small utilities -------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const chunk = (a, n) => {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};
const arrStr = (a, n) =>
  Array.isArray(a) ? a.slice(0, n).map((x) => String(x)).filter(Boolean) : [];
const tierOf = (t) =>
  ["apply_now", "strong", "worth_a_look"].includes(t) ? t : "worth_a_look";

function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function apiError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const loadC = (k) => {
  try {
    return JSON.parse(localStorage.getItem(k)) || {};
  } catch {
    return {};
  }
};
const saveC = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* quota — Deep Scan still works this session, just not cached */
  }
};

/** "Clear AI cache" (in App) removes these alongside the Smart-rank caches. */
export function clearDeepScanCache() {
  for (const k of Object.values(CACHE)) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

// Robust parse: strip prose/fences, take the first [ ... ] span.
function extractArray(text) {
  const t = (text || "").trim();
  const s = t.indexOf("[");
  const e = t.lastIndexOf("]");
  if (s === -1 || e === -1 || e < s) throw new Error("no JSON array in response");
  const parsed = JSON.parse(t.slice(s, e + 1));
  if (!Array.isArray(parsed)) throw new Error("response was not a JSON array");
  return parsed;
}

// Direct browser call with 429 backoff (honors Retry-After) and network retry.
async function callSonnet(apiKey, system, user, maxTokens) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          thinking: { type: "disabled" },
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
    } catch (netErr) {
      if (attempt < 3) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw apiError(undefined, netErr?.message || "Network request failed");
    }

    if (res.status === 429 && attempt < 5) {
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Number.isFinite(ra)
        ? ra * 1000
        : Math.min(16000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 400);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      let msg = "";
      try {
        const e = await res.json();
        msg = e?.error?.message || "";
      } catch {
        /* non-JSON error body */
      }
      throw apiError(res.status, msg || `HTTP ${res.status}`);
    }

    const data = await res.json();
    return (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}

// Bounded-concurrency runner.
async function runPool(items, size, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) await fn(items[i++]);
  }
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) || 1 }, worker)
  );
}

// ---- Stage 0: candidate pool ----------------------------------------------
/**
 * Union of: top 1500 by TF-IDF (`.match`), top 1500 by local embeddings
 * (`.sem`, when present), and EVERY job whose title contains a profile target
 * title. Deduped. Nothing outside the pool is lost — it stays keyword-ranked.
 */
export function buildPool(jobs, profile) {
  const byTfidf = [...jobs]
    .sort((a, b) => (b.match || 0) - (a.match || 0))
    .slice(0, POOL_EACH);

  const hasSem = jobs.some((j) => typeof j.sem === "number");
  const bySem = hasSem
    ? [...jobs].sort((a, b) => (b.sem || 0) - (a.sem || 0)).slice(0, POOL_EACH)
    : [];

  const titles = (profile?.titles || [])
    .map((t) => (t || "").toLowerCase().trim())
    .filter(Boolean);
  const byTitle = titles.length
    ? jobs.filter((j) => {
        const t = (j.title || "").toLowerCase();
        return titles.some((x) => t.includes(x));
      })
    : [];

  const seen = new Set();
  const pool = [];
  for (const j of [...byTfidf, ...bySem, ...byTitle]) {
    const id = String(j.id);
    if (!seen.has(id)) {
      seen.add(id);
      pool.push(j);
    }
  }
  return pool;
}

/**
 * Rough, pre-flight cost estimate (approximate token accounting).
 * Sonnet 5 standard pricing: $3 / MTok input, $15 / MTok output.
 */
export function estimateCost(poolSize) {
  const screenN = poolSize;
  const s1in = screenN * 130 + Math.ceil(screenN / 40) * 300;
  const s1out = screenN * 8;

  const deepN = Math.min(SCREEN_KEEP, poolSize);
  const s2in = deepN * 1300 + Math.ceil(deepN / 8) * 700;
  const s2out = deepN * 140;

  const tournN = Math.min(TOURNAMENT_KEEP, deepN);
  const s3in = tournN * 90 + 900;
  const s3out = tournN * 45;

  const inTok = s1in + s2in + s3in;
  const outTok = s1out + s2out + s3out;
  const usd = (inTok / 1e6) * 3 + (outTok / 1e6) * 15;
  return { poolSize, screenN, deepN, tournN, inTok, outTok, usd };
}

// ---- prompts ---------------------------------------------------------------
function profileBlock(profile, includeSummary) {
  if (!profile) return "";
  const lines = [
    "=== CANDIDATE PROFILE ===",
    profile.seniority && `Seniority: ${profile.seniority}`,
    profile.years_experience && `Years of experience: ${profile.years_experience}`,
    profile.domains?.length && `Domains: ${profile.domains.join(", ")}`,
    profile.titles?.length && `Target roles: ${profile.titles.join(", ")}`,
    includeSummary && profile.summary && `Summary: ${profile.summary}`,
  ].filter(Boolean);
  return lines.length > 1 ? lines.join("\n") + "\n" : "";
}

const SCREEN_SYS = (profile) =>
  [
    "You are an expert technical recruiter doing a fast first-pass screen of job postings for one candidate.",
    profileBlock(profile, true),
    "Score each job 0-100 for plausible fit. This is a cheap breadth pass whose only job is to",
    "eliminate obvious non-fits — be decisive, don't agonize. A score below 30 means clearly not a fit.",
    'Return ONLY a JSON array [{"id": <id>, "score": <0-100>}], one entry per job. No prose, no markdown.',
  ].join("\n");

const DEEP_SYS = [
  "You are a senior technical recruiter doing a careful, skeptical deep read of job postings for one candidate.",
  "Exercise genuine judgment: calibrate seniority (is the candidate over/under-leveled?), assess real domain",
  "fit, and consider trajectory (is this a sensible NEXT role, not just any role?). Be skeptical — most jobs",
  "are mediocre fits. Scores above 85 should be RARE and reserved for genuinely excellent, realistic matches.",
  "",
  "For each job return an object with EXACTLY these keys:",
  '  "id": the job id,',
  '  "score": 0-100 genuine-fit score,',
  '  "fit_reasons": up to 3 short strings (why this could work),',
  '  "gaps": up to 2 short strings (what is missing or risky for this candidate),',
  '  "comp_check": one of "above" | "within" | "below" | "unknown" — the posting\'s stated pay vs. the',
  "     candidate's likely expectations given seniority ('unknown' if no comp is stated),",
  '  "apply_angle": <= 25 words — the single strongest thing this candidate should lead with when applying.',
  'Return ONLY a JSON array of these objects. No prose, no markdown, no code fences.',
].join("\n");

const TOURN_SYS = [
  "You are a senior recruiter building a final shortlist for ONE candidate. You are given a set of jobs that",
  "already passed a deep screen, each with fit reasons and gaps. Absolute scores drift across separate reviews;",
  "your job is COMPARATIVE — rank these jobs against each other for THIS specific candidate.",
  "",
  "Return ONLY a JSON array [{",
  '  "id": the job id,',
  '  "rank": 1 = best, ascending with no ties,',
  '  "tier": "apply_now" (top, genuinely strong + realistic) | "strong" (worth real effort) | "worth_a_look" (maybe),',
  '  "note": <= 15 words on why it sits where it does',
  "}]. No prose, no markdown.",
].join("\n");

const screenUser = (batch) =>
  [
    "Jobs to screen (JSON):",
    JSON.stringify(
      batch.map((j) => ({
        id: j.id,
        company: j.company,
        title: j.title,
        location: j.location || "",
        comp: j.comp || "",
        description: (j.description || "").slice(0, 300),
      }))
    ),
    "",
    "Score every job. Return only the JSON array.",
  ].join("\n");

const deepUser = (resumeText, profile, batch) =>
  [
    profileBlock(profile, false),
    "=== FULL RÉSUMÉ ===",
    resumeText,
    "",
    "=== JOBS (full descriptions, JSON) ===",
    JSON.stringify(
      batch.map((j) => ({
        id: j.id,
        company: j.company,
        title: j.title,
        location: j.location || "",
        comp: j.comp || "",
        description: (j.description || "").slice(0, 4000),
      }))
    ),
    "",
    "Deep-read every job. Return only the JSON array in the specified shape.",
  ].join("\n");

const tournUser = (profile, finalists) =>
  [
    profileBlock(profile, true),
    "=== SHORTLIST TO RANK (JSON) ===",
    JSON.stringify(
      finalists.map(({ job, deep }) => ({
        id: job.id,
        company: job.company,
        title: job.title,
        location: job.location || "",
        comp: job.comp || "",
        fit_reasons: deep.fit_reasons,
        gaps: deep.gaps,
      }))
    ),
    "",
    "Rank all of them 1..N for this candidate. Return only the JSON array.",
  ].join("\n");

// ---- normalization ---------------------------------------------------------
function normalizeDeep(r) {
  return {
    score: clamp(r.score),
    fit_reasons: arrStr(r.fit_reasons, 3),
    gaps: arrStr(r.gaps, 2),
    comp_check: ["above", "within", "below", "unknown"].includes(r.comp_check)
      ? r.comp_check
      : "unknown",
    apply_angle: String(r.apply_angle || "").slice(0, 200),
  };
}

function mergeRow(job, deep, t) {
  return {
    id: String(job.id),
    company: job.company,
    title: job.title,
    location: job.location || "",
    comp: job.comp || "",
    remote: job.remote,
    source: job.source,
    url: job.url,
    description: job.description,
    score: deep.score,
    fit_reasons: deep.fit_reasons,
    gaps: deep.gaps,
    comp_check: deep.comp_check,
    apply_angle: deep.apply_angle,
    rank: t.rank,
    tier: t.tier,
    note: t.note || "",
  };
}

// ---- the cascade -----------------------------------------------------------
export async function deepScan(resumeText, profile, jobs, apiKey, onProgress) {
  const warnings = [];
  const hkey = hashText(resumeText);
  const report = (stage, label, done, total) =>
    onProgress?.({ stage, label, done, total });

  // STAGE 0 — pool
  report("pool", "Building candidate pool", 0, 1);
  const pool = buildPool(jobs, profile);
  report("pool", "Candidate pool ready", 1, 1);

  // STAGE 1 — screen (only score jobs not already cached for this résumé)
  const screenCache = loadC(CACHE.screen);
  const need1 = pool.filter((j) => screenCache[`${hkey}:${j.id}`] === undefined);
  const batches1 = chunk(need1, 40);
  let d1 = 0;
  report("screen", "LLM screen", 0, batches1.length);
  await runPool(batches1, 4, async (batch) => {
    try {
      const text = await callSonnet(apiKey, SCREEN_SYS(profile), screenUser(batch), 1500);
      const parsed = extractArray(text);
      const ids = new Set(batch.map((j) => String(j.id)));
      for (const r of parsed) {
        const id = String(r?.id);
        if (ids.has(id)) screenCache[`${hkey}:${id}`] = clamp(r.score);
      }
    } catch (e) {
      warnings.push(`Screen batch skipped (${e.message}).`);
    } finally {
      d1 += 1;
      saveC(CACHE.screen, screenCache);
      report("screen", "LLM screen", d1, batches1.length);
    }
  });

  const survivors = pool
    .map((j) => ({ j, s: screenCache[`${hkey}:${j.id}`] ?? 0 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, SCREEN_KEEP)
    .map((x) => x.j);

  // STAGE 2 — deep read
  const deepCache = loadC(CACHE.deep);
  const need2 = survivors.filter((j) => !deepCache[`${hkey}:${j.id}`]);
  const batches2 = chunk(need2, 8);
  let d2 = 0;
  report("deep", "Deep read", 0, batches2.length);
  await runPool(batches2, 3, async (batch) => {
    try {
      const text = await callSonnet(apiKey, DEEP_SYS, deepUser(resumeText, profile, batch), 4000);
      const parsed = extractArray(text);
      const byId = new Map(batch.map((j) => [String(j.id), j]));
      for (const r of parsed) {
        const id = String(r?.id);
        if (byId.has(id)) deepCache[`${hkey}:${id}`] = normalizeDeep(r);
      }
    } catch (e) {
      warnings.push(`Deep-read batch skipped (${e.message}).`);
    } finally {
      d2 += 1;
      saveC(CACHE.deep, deepCache);
      report("deep", "Deep read", d2, batches2.length);
    }
  });

  const deepList = survivors
    .map((j) => ({ job: j, deep: deepCache[`${hkey}:${j.id}`] }))
    .filter((x) => x.deep)
    .sort((a, b) => b.deep.score - a.deep.score);
  const finalists = deepList.slice(0, TOURNAMENT_KEEP);

  // STAGE 3 — tournament (comparative, cached by the exact finalist set)
  report("tournament", "Tournament", 0, 1);
  let tournament = [];
  if (finalists.length) {
    const sig = finalists.map((x) => String(x.job.id)).sort().join(",");
    const tkey = `${hkey}:${hashText(sig)}`;
    const tournCache = loadC(CACHE.tourn);
    if (tournCache[tkey]) {
      tournament = tournCache[tkey];
    } else {
      try {
        const text = await callSonnet(apiKey, TOURN_SYS, tournUser(profile, finalists), 2000);
        tournament = extractArray(text)
          .filter((r) => r && r.id != null)
          .map((r) => ({
            id: String(r.id),
            rank: Number(r.rank) || 999,
            tier: tierOf(r.tier),
            note: String(r.note || "").slice(0, 120),
          }));
        tournCache[tkey] = tournament;
        saveC(CACHE.tourn, tournCache);
      } catch (e) {
        warnings.push(`Tournament skipped (${e.message}); using deep-read order.`);
      }
    }
  }
  report("tournament", "Tournament", 1, 1);

  // Merge into the final tiered list.
  const byId = new Map(finalists.map((x) => [String(x.job.id), x]));
  let ranked;
  if (tournament.length) {
    ranked = tournament
      .filter((t) => byId.has(t.id))
      .sort((a, b) => a.rank - b.rank)
      .map((t) => {
        const { job, deep } = byId.get(t.id);
        return mergeRow(job, deep, t);
      });
  } else {
    // Fallback: no tournament — synthesize tiers from deep-read scores.
    ranked = finalists.map((x, i) =>
      mergeRow(x.job, x.deep, {
        rank: i + 1,
        tier: x.deep.score >= 80 ? "apply_now" : x.deep.score >= 65 ? "strong" : "worth_a_look",
        note: "",
      })
    );
  }

  return {
    ranked,
    warnings,
    stats: {
      pool: pool.length,
      survivors: survivors.length,
      deep: deepList.length,
      ranked: ranked.length,
    },
  };
}

// ---- CSV export ------------------------------------------------------------
export function deepScanCSV(rows) {
  const cols = ["company", "title", "location", "comp", "tier", "rank", "score", "apply_angle", "url"];
  const esc = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.join(",");
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
  return head + "\n" + body + "\n";
}
