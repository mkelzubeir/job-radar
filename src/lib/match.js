/**
 * Match scoring: compares a job posting against resume keywords.
 * Title hits count 4x description hits; phrase (bigram) keywords carry
 * their higher extraction weight through. Output is 0–100.
 */
export function scoreJob(job, keywords, targetTitles = []) {
  if (!keywords.length && !targetTitles.length) return 0;

  const title = job.title.toLowerCase();
  const desc = (job.description || "").toLowerCase();
  const totalWeight =
    keywords.reduce((s, k) => s + k.weight, 0) + targetTitles.length * 12;

  let score = 0;
  for (const { term, weight } of keywords) {
    if (title.includes(term)) score += weight * 4;
    else if (desc.includes(term)) score += weight;
  }
  for (const t of targetTitles) {
    const tt = t.toLowerCase().trim();
    if (!tt) continue;
    if (title.includes(tt)) score += 12 * 4;
    else if (desc.includes(tt)) score += 12;
  }

  // Normalize: a job matching ~35% of total keyword weight in titles is a 100.
  const normalized = Math.min(100, Math.round((score / (totalWeight * 1.4)) * 100));
  return normalized;
}

export function rankJobs(jobs, keywords, targetTitles) {
  return jobs
    .map((j) => ({ ...j, match: scoreJob(j, keywords, targetTitles) }))
    .sort((a, b) => b.match - a.match || (b.postedAt || "").localeCompare(a.postedAt || ""));
}
