/**
 * Stage 2 of ranking: semantic re-rank with Claude ("Smart rank").
 *
 * Stage 1 (TF-IDF, src/lib/match.js) is retrieval — it selects the top-N
 * candidates. This module is the ranker: it scores those candidates against the
 * FULL resume text.
 *
 * The user supplies their own Anthropic API key and the request goes DIRECTLY
 * from the browser to the Anthropic API — there is no backend. The key lives
 * only in React state (never persisted). In this mode the resume text and a
 * compact view of the candidate jobs are sent to Anthropic.
 */
const API_URL = "https://api.anthropic.com/v1/messages";
// The whole app uses Sonnet 5 (Smart rank + profile here, Deep Scan in deepscan.js).
const MODEL = "claude-sonnet-5";
const CACHE_KEY = "jobradar.aiScores";
const PROFILE_KEY = "jobradar.profile";
const BATCH_SIZE = 20;
const CONCURRENCY = 3;

const SYSTEM = [
  "You are an expert technical recruiter scoring how well a candidate fits each job.",
  "Score each job 0-100 for GENUINE fit, considering: seniority level, domain",
  "overlap, transferable skills, and trajectory — a sensible next role for this",
  "candidate, not just keyword overlap. Prefer roles the candidate clearly clears",
  "the bar for over aspirational reaches.",
  "",
  'Return ONLY a JSON array of {"id","score","reason"} objects, one per job, where',
  '"reason" is <= 12 words. No prose, no markdown, no code fences — the raw array only.',
].join("\n");

// tiny stable string hash (djb2) — used to key the cache to the resume version.
function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveCache(obj) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch {
    /* quota / private mode — scoring still works, just not cached */
  }
}
export function clearAiCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* ignore */
  }
}

// Robust parse: strip ```json fences, take the first [ ... ] span, JSON.parse.
function extractJsonArray(text) {
  const t = (text || "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON array found in response");
  }
  const parsed = JSON.parse(t.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("response was not a JSON array");
  return parsed;
}

// Same, for a single { ... } object.
function extractJsonObject(text) {
  const t = (text || "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in response");
  }
  const parsed = JSON.parse(t.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("response was not a JSON object");
  }
  return parsed;
}

const PROFILE_SYSTEM = [
  "You are an expert technical recruiter. Read the résumé and extract a structured profile.",
  "Return ONLY JSON, no prose or markdown, shaped exactly:",
  '{"skills":[{"term":string,"weight":number}], "domains":[string], "titles":[string],',
  ' "seniority":string, "years_experience":number, "summary":string}',
  "where skill weight is 1-10 (how central the skill is), titles are 3-6 realistic",
  "next-role titles, and summary is <= 40 words. Skills should be concrete",
  "technologies/methods, not soft skills.",
].join("\n");

// Error that carries the HTTP status so the UI can map it to friendly copy.
// `status` is undefined for network/CORS failures (fetch itself rejected).
function apiError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function callClaude(apiKey, system, userMsg, maxTokens = 1500) {
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
        messages: [{ role: "user", content: userMsg }],
      }),
    });
  } catch (netErr) {
    // fetch() rejects on network failure or a blocked CORS request — no status.
    throw apiError(undefined, netErr?.message || "Network request failed");
  }

  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.error?.message || "";
    } catch {
      /* non-JSON error body */
    }
    throw apiError(res.status, detail || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function loadProfileCache() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {};
  } catch {
    return {};
  }
}

/**
 * Extract a structured candidate profile from the résumé with one Claude call.
 * Cached in localStorage by résumé hash so it isn't re-billed on reload.
 * @returns {Promise<{skills:{term:string,weight:number}[], domains:string[], titles:string[], seniority:string, years_experience:number, summary:string}>}
 */
export async function extractProfile(resumeText, apiKey) {
  const hkey = hashText(resumeText);
  const cache = loadProfileCache();
  if (cache[hkey]) return cache[hkey];

  const text = await callClaude(
    apiKey,
    PROFILE_SYSTEM,
    `=== RÉSUMÉ ===\n${resumeText}\n\nExtract the profile as JSON only.`
  );
  const raw = extractJsonObject(text);
  const profile = {
    skills: Array.isArray(raw.skills)
      ? raw.skills
          .filter((s) => s && s.term)
          .map((s) => ({
            term: String(s.term),
            weight: Math.max(1, Math.min(10, Number(s.weight) || 5)),
          }))
      : [],
    domains: Array.isArray(raw.domains) ? raw.domains.map(String) : [],
    titles: Array.isArray(raw.titles) ? raw.titles.map(String) : [],
    seniority: typeof raw.seniority === "string" ? raw.seniority : "",
    years_experience: Number(raw.years_experience) || 0,
    summary: typeof raw.summary === "string" ? raw.summary : "",
  };

  cache[hkey] = profile;
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(cache));
  } catch {
    /* quota — profile still returned, just not cached */
  }
  return profile;
}

function profileBlock(profile) {
  if (!profile) return "";
  const domains = (profile.domains || []).join(", ");
  const titles = (profile.titles || []).join(", ");
  return [
    "=== CANDIDATE PROFILE (structured) ===",
    `Seniority: ${profile.seniority || "unknown"}`,
    `Years of experience: ${profile.years_experience || "unknown"}`,
    domains && `Domains: ${domains}`,
    titles && `Likely next roles: ${titles}`,
    profile.summary && `Summary: ${profile.summary}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function scoreBatch(resumeText, batch, apiKey, profile) {
  const compact = batch.map((j) => ({
    id: j.id,
    company: j.company,
    title: j.title,
    location: j.location || "",
    comp: j.comp || "",
    description: (j.description || "").slice(0, 800),
  }));

  const userMsg = [
    profileBlock(profile),
    "=== CANDIDATE RÉSUMÉ ===",
    resumeText,
    "",
    "=== JOBS (JSON) ===",
    JSON.stringify(compact),
    "",
    "Score every job. Return only the JSON array.",
  ].join("\n");

  // Sonnet 5 enables adaptive thinking by default; callClaude disables it so the
  // whole budget goes to the JSON array (this is a scoring task, not reasoning).
  const text = await callClaude(apiKey, SYSTEM, userMsg, 2000);
  return extractJsonArray(text);
}

/**
 * Score `jobs` against `resumeText`. Batches ~20 jobs/request, max 3 concurrent.
 * Results are cached in localStorage keyed by hash(resumeText)+job id so
 * re-scans and reloads don't re-bill. Per-batch failures are non-fatal — those
 * jobs simply keep their keyword score and a warning is returned.
 *
 * @returns {Promise<{ scores: Map<string,{score:number,reason:string}>, warnings: string[] }>}
 */
export async function semanticRank(resumeText, jobs, apiKey, opts = {}) {
  const { onProgress, profile } = opts;
  const hkey = hashText(resumeText);
  const cache = loadCache();
  const scores = new Map();
  const warnings = [];

  // Serve cache hits immediately; only score the misses.
  const toScore = [];
  for (const j of jobs) {
    const cached = cache[`${hkey}:${j.id}`];
    if (cached) scores.set(String(j.id), cached);
    else toScore.push(j);
  }

  const batches = [];
  for (let i = 0; i < toScore.length; i += BATCH_SIZE) {
    batches.push(toScore.slice(i, i + BATCH_SIZE));
  }

  let done = 0;
  onProgress?.(done, batches.length);

  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const arr = await scoreBatch(resumeText, batch, apiKey, profile);
        const byId = new Map(batch.map((j) => [String(j.id), j]));
        for (const r of arr) {
          if (!r || r.id == null) continue;
          const id = String(r.id);
          if (!byId.has(id)) continue;
          const entry = {
            score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
            reason: typeof r.reason === "string" ? r.reason : "",
          };
          scores.set(id, entry);
          cache[`${hkey}:${id}`] = entry;
        }
      } catch (e) {
        warnings.push(
          `A batch of ${batch.length} jobs couldn't be scored (${e.message}); they keep their keyword score.`
        );
      } finally {
        done++;
        onProgress?.(done, batches.length);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker)
  );
  saveCache(cache);
  return { scores, warnings };
}
