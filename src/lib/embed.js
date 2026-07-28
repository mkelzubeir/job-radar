/**
 * Optional local semantic retrieval — no API key required.
 *
 * Lazy-loaded ONLY when the user enables "Semantic boost". transformers.js and
 * the ~25MB quantized MiniLM model are pulled in via dynamic import(), so they
 * are code-split out of the main bundle and downloaded once (browser-cached).
 *
 * Blended keyword-stage score = 0.5 * cosine(resume, job) + 0.5 * normalized TF-IDF.
 */

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractorPromise = null;

// Load the feature-extraction pipeline once. Dynamic import keeps transformers.js
// out of the main chunk.
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      // Fetch the hosted model rather than looking for a local copy.
      env.allowLocalModels = false;
      return pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
    })().catch((e) => {
      extractorPromise = null; // allow a later retry
      throw e;
    });
  }
  return extractorPromise;
}

// Vectors are already unit-normalized, so cosine similarity is just the dot product.
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

async function embed(extractor, text) {
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return out.data; // Float32Array (normalized, mean-pooled)
}

/** In-memory per-scan cache of job embeddings, keyed by job id. */
export function createEmbedCache() {
  return new Map();
}

/**
 * Blend semantic similarity with the existing TF-IDF match for each job.
 * Embeds the résumé once and each job (title + first 300 chars), reusing the
 * cache across calls within the same scan. Throws if the model fails to load —
 * callers fall back to plain TF-IDF.
 *
 * @returns {Promise<Map<string, number>>} jobId -> blended score (0-100)
 */
export async function semanticBoost(resumeText, jobs, cache, onProgress) {
  const extractor = await getExtractor();
  const resumeVec = await embed(extractor, resumeText.slice(0, 2000));

  const maxMatch = Math.max(1, ...jobs.map((j) => j.match || 0));
  const out = new Map();
  let done = 0;
  onProgress?.(0, jobs.length);

  for (const j of jobs) {
    let vec = cache.get(j.id);
    if (!vec) {
      const text = `${j.title || ""}\n${(j.description || "").slice(0, 300)}`;
      vec = await embed(extractor, text);
      cache.set(j.id, vec);
    }
    const cos = Math.max(0, dot(resumeVec, vec)); // 0..1
    const tfidf = (j.match || 0) / maxMatch; // 0..1
    out.set(j.id, Math.round((0.5 * cos + 0.5 * tfidf) * 100));
    onProgress?.(++done, jobs.length);
  }
  return out;
}
