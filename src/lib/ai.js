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
// NOTE: spec named claude-sonnet-4-6, but the standing instruction for this
// project is to use Sonnet 5. Change here to switch models.
const MODEL = "claude-sonnet-5";
const CACHE_KEY = "jobradar.aiScores";
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

async function scoreBatch(resumeText, batch, apiKey) {
  const compact = batch.map((j) => ({
    id: j.id,
    company: j.company,
    title: j.title,
    location: j.location || "",
    comp: j.comp || "",
    description: (j.description || "").slice(0, 800),
  }));

  const userMsg = [
    "=== CANDIDATE RESUME ===",
    resumeText,
    "",
    "=== JOBS (JSON) ===",
    JSON.stringify(compact),
    "",
    "Score every job. Return only the JSON array.",
  ].join("\n");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      // Sonnet 5 enables adaptive thinking by default; disable it so the whole
      // budget goes to the JSON array (this is a scoring task, not reasoning).
      thinking: { type: "disabled" },
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!res.ok) {
    let detail = String(res.status);
    try {
      const err = await res.json();
      detail = err?.error?.message || detail;
    } catch {
      /* non-JSON error body — keep the status code */
    }
    throw new Error(`Anthropic API ${detail}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
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
  const { onProgress } = opts;
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
        const arr = await scoreBatch(resumeText, batch, apiKey);
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
