/**
 * Optional semantic re-ranking with Claude.
 *
 * The user supplies their own Anthropic API key. The request goes DIRECTLY from
 * the browser to the Anthropic API — there is no backend — so the resume text
 * and a compact list of the top jobs are sent to Anthropic in this mode. The
 * key lives only in React state (never localStorage) and is used only here.
 */
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

// Claude sometimes wraps JSON in ```json fences despite instructions; strip them.
const stripFences = (s) =>
  s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

/**
 * Re-rank the top ~30 keyword-ranked jobs semantically.
 * @returns Map<jobId, { score: number, reason: string }>
 */
export async function aiRerank({ apiKey, resumeText, jobs }) {
  const top = jobs.slice(0, 30).map((j) => ({
    id: j.id,
    company: j.company,
    title: j.title,
    description: (j.description || "").slice(0, 600),
  }));

  const prompt = [
    "You are ranking job postings against a candidate's resume.",
    "Judge GENUINE fit: seniority match, domain overlap, transferable skills.",
    "",
    "=== RESUME ===",
    resumeText,
    "",
    "=== JOBS (JSON) ===",
    JSON.stringify(top),
    "",
    "Return ONLY a JSON array, one object per job, shaped exactly like:",
    '[{"id": "<the job id>", "score": <integer 0-100>, "reason": "<=15 words"}]',
    "No prose and no markdown code fences — output the raw JSON array only.",
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
      // Sonnet 5 runs adaptive thinking by default; disable it so the whole
      // 2000-token budget goes to the JSON array (a quick classification).
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
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
    throw new Error(`Anthropic API error: ${detail}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  let parsed;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    throw new Error("Could not parse the AI response as JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("AI response was not a JSON array.");
  }

  const byId = new Map();
  for (const r of parsed) {
    if (!r || r.id == null) continue;
    byId.set(String(r.id), {
      score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
      reason: typeof r.reason === "string" ? r.reason : "",
    });
  }
  return byId;
}
