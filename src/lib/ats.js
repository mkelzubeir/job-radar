/**
 * ATS adapters
 * Each adapter fetches a company's public job board API and normalizes
 * postings to a single shape:
 * { id, source, company, title, location, remote, comp, description, url, postedAt }
 *
 * All five platforms expose public, CORS-enabled JSON endpoints intended
 * for embedding job boards, so no API keys or backend are required.
 */

const stripHtml = (html) => {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || "").replace(/\s+/g, " ").trim();
};

// Pull a salary range out of free text when the ATS doesn't expose one.
const COMP_RE =
  /(?:[$£€]\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s?[kK]?)\s?(?:-|–|—|to)\s?(?:[$£€]\s?)?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s?[kK]?/;
export const compFromText = (text) => {
  const m = (text || "").match(COMP_RE);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
};

const norm = (j) => ({
  remote: false,
  comp: null,
  postedAt: null,
  ...j,
  description: (j.description || "").slice(0, 4000),
});

export const ADAPTERS = {
  ashby: {
    label: "Ashby",
    boardUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    async fetch(slug, company) {
      const r = await fetch(
        `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`
      );
      if (!r.ok) throw new Error(`Ashby ${r.status}`);
      const data = await r.json();
      return (data.jobs || []).map((j) =>
        norm({
          id: `ashby-${j.id}`,
          source: "Ashby",
          company: company || data.name || slug,
          title: j.title,
          location: j.location || "",
          remote: !!j.isRemote,
          comp: j.compensation?.compensationTierSummary || null,
          description: stripHtml(j.descriptionHtml),
          url: j.jobUrl || j.applyUrl,
          postedAt: j.publishedAt || null,
        })
      );
    },
  },

  greenhouse: {
    label: "Greenhouse",
    boardUrl: (slug) => `https://boards.greenhouse.io/${slug}`,
    async fetch(slug, company) {
      const r = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`
      );
      if (!r.ok) throw new Error(`Greenhouse ${r.status}`);
      const data = await r.json();
      return (data.jobs || []).map((j) => {
        const desc = stripHtml(j.content);
        return norm({
          id: `gh-${j.id}`,
          source: "Greenhouse",
          company: company || slug,
          title: j.title,
          location: j.location?.name || "",
          remote: /remote/i.test(j.location?.name || ""),
          comp: compFromText(desc),
          description: desc,
          url: j.absolute_url,
          postedAt: j.updated_at || null,
        });
      });
    },
  },

  lever: {
    label: "Lever",
    boardUrl: (slug) => `https://jobs.lever.co/${slug}`,
    async fetch(slug, company) {
      const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      if (!r.ok) throw new Error(`Lever ${r.status}`);
      const data = await r.json();
      return (data || []).map((j) => {
        const sr = j.salaryRange;
        const comp = sr?.min
          ? `${sr.currency || "$"}${Math.round(sr.min / 1000)}K – ${sr.currency || "$"}${Math.round(sr.max / 1000)}K`
          : compFromText(j.descriptionPlain);
        return norm({
          id: `lever-${j.id}`,
          source: "Lever",
          company: company || slug,
          title: j.text,
          location: j.categories?.location || "",
          remote: /remote/i.test(
            `${j.categories?.location || ""} ${j.workplaceType || ""}`
          ),
          comp,
          description: j.descriptionPlain || stripHtml(j.description),
          url: j.hostedUrl,
          postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        });
      });
    },
  },

  smartrecruiters: {
    label: "SmartRecruiters",
    boardUrl: (slug) => `https://careers.smartrecruiters.com/${slug}`,
    async fetch(slug, company) {
      const r = await fetch(
        `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`
      );
      if (!r.ok) throw new Error(`SmartRecruiters ${r.status}`);
      const data = await r.json();
      return (data.content || []).map((j) =>
        norm({
          id: `sr-${j.id}`,
          source: "SmartRecruiters",
          company: company || j.company?.name || slug,
          title: j.name,
          location: [j.location?.city, j.location?.country?.toUpperCase()]
            .filter(Boolean)
            .join(", "),
          remote: !!j.location?.remote,
          description: [j.department?.label, j.function?.label, j.experienceLevel?.label]
            .filter(Boolean)
            .join(" · "),
          url: `https://jobs.smartrecruiters.com/${encodeURIComponent(
            j.company?.identifier || slug
          )}/${j.id}`,
          postedAt: j.releasedDate || null,
        })
      );
    },
  },

  workable: {
    label: "Workable",
    boardUrl: (slug) => `https://apply.workable.com/${slug}`,
    async fetch(slug, company) {
      const r = await fetch(
        `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`
      );
      if (!r.ok) throw new Error(`Workable ${r.status}`);
      const data = await r.json();
      return (data.jobs || []).map((j) => {
        const desc = stripHtml(j.description);
        return norm({
          id: `wk-${j.shortcode}`,
          source: "Workable",
          company: company || data.name || slug,
          title: j.title,
          location: [j.city, j.country].filter(Boolean).join(", "),
          remote: /remote/i.test(`${j.telecommuting ? "remote" : ""} ${j.city || ""}`),
          comp: compFromText(desc),
          description: desc,
          url: j.url,
          postedAt: j.published_on || null,
        });
      });
    },
  },
};

/** Fetch all companies concurrently; returns { jobs, errors } */
export async function scanCompanies(companies, onProgress) {
  const jobs = [];
  const errors = [];
  let done = 0;
  await Promise.all(
    companies.map(async (c) => {
      try {
        const adapter = ADAPTERS[c.ats];
        if (!adapter) throw new Error(`Unknown ATS: ${c.ats}`);
        const res = await adapter.fetch(c.slug, c.name);
        jobs.push(...res);
      } catch (e) {
        errors.push({ company: c.name || c.slug, ats: c.ats, message: e.message });
      } finally {
        done += 1;
        onProgress?.(done, companies.length);
      }
    })
  );
  return { jobs, errors };
}
