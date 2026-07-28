/**
 * Match scoring: ranks job postings against resume keywords using TF-IDF
 * weighted overlap. Terms that appear in nearly every scanned job ("data",
 * "team") get a near-zero idf and contribute almost nothing; rare, specific
 * terms dominate. Output is 0–100 where 100 = "best fit in today's scan".
 */
export function rankJobs(jobs, keywords = [], targetTitles = []) {
  const N = jobs.length;
  if (!N) return [];

  // Lowercased haystacks per job — title and description matched separately.
  const docs = jobs.map((j) => {
    const title = (j.title || "").toLowerCase();
    const desc = (j.description || "").toLowerCase();
    return { title, desc, text: `${title} ${desc}` };
  });

  // Effective weight per keyword = weight * idf, where idf = ln(1 + N/(1+df))
  // and df is the number of scanned jobs whose title+description contains the
  // term (lowercase substring match).
  const effective = (keywords || [])
    .filter((k) => k && k.term)
    .map((k) => {
      const term = k.term.toLowerCase();
      let df = 0;
      for (const d of docs) if (d.text.includes(term)) df++;
      const idf = Math.log(1 + N / (1 + df));
      return { term, eff: (k.weight || 0) * idf };
    });

  // Optional target titles, normalized and de-blanked.
  const titles = (targetTitles || [])
    .map((t) => (t || "").toLowerCase().trim())
    .filter(Boolean);

  // "strong" reference: what a genuinely strong resume match looks like, used
  // as a floor for the denominator so a scan of uniformly poor fits stays low.
  const topEff = effective
    .map((e) => e.eff)
    .sort((a, b) => b - a)
    .slice(0, 8)
    .reduce((s, v) => s + v, 0);
  const strong = 2.5 * topEff + 40 * titles.length;

  const rawScores = docs.map((d) => {
    let raw = 0;

    for (const { term, eff } of effective) {
      if (!eff) continue;
      if (d.title.includes(term)) raw += eff * 4; // title hit
      else if (d.desc.includes(term)) raw += eff; // description hit
    }

    for (const tt of titles) {
      if (d.title.includes(tt)) {
        raw += 40; // exact substring in job title
      } else {
        // partial credit: fraction of the title's words (>2 chars) present
        const words = tt.split(/\s+/).filter((w) => w.length > 2);
        const present = words.filter((w) => d.title.includes(w)).length;
        if (words.length && present) raw += (present / words.length) * 20;
      }
      if (d.desc.includes(tt)) raw += 10; // description mention
    }

    return raw;
  });

  // Denominator = max(best raw score in scan, 0.6 * strong). NOT percentile
  // normalization: when hundreds of generic jobs share an identical weak score,
  // the 95th percentile IS that weak score and everything inflates to 100.
  const bestRaw = rawScores.reduce((m, v) => Math.max(m, v), 0);
  const denom = Math.max(bestRaw, 0.6 * strong) || 1;

  return jobs
    .map((j, i) => {
      const raw = rawScores[i];
      const match =
        raw <= 0 ? 0 : Math.min(100, Math.round((raw / denom) * 100));
      return { ...j, match };
    })
    .sort(
      (a, b) =>
        b.match - a.match ||
        (b.postedAt || "").localeCompare(a.postedAt || "")
    );
}
