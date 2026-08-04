/**
 * Post-scan filter engine.
 *
 * Every scanned job is enriched once (enrichJob) with:
 *   - category:   role family classified from the title ("Engineering",
 *                 "Operations", "Strategy & BizOps", ...) so whole families
 *                 (e.g. software engineering) can be included/excluded.
 *   - seniority:  level parsed from the title (intern → exec).
 *   - reqYears:   years of experience the description explicitly requires
 *                 ("5+ years of experience", "five years' experience", "3-5
 *                 years in ...").
 *   - effYears:   reqYears, or the years implied by the title's seniority
 *                 when the description states none (Staff ≈ 8, Director ≈ 10).
 *   - compMax:    upper bound of the posted comp range, in dollars.
 *
 * jobPassesFilters applies the persisted filter state to an enriched job.
 * Category/seniority filters are tri-state: include (only these), exclude
 * (never these), or neutral.
 */

// ---------------------------------------------------------------- experience

const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// "N years" mentions in job descriptions are overwhelmingly experience
// requirements, but not always ("founded 12 years ago", "401k after 1 year").
// Require nearby experience-flavored context before counting a mention.
const CTX_AFTER =
  /^[\s'’]*(?:\+|plus)?\s*(?:of\s+)?(?:(?:[a-z][\w/&,-]*\s+){0,4}(?:experience|exp\b|track record|background)|in\s+[a-z]|working\s)/;
const CTX_BEFORE =
  /(?:experience|minimum|at least|requires?|ideally|preferably|least)\s*(?:of|:)?\s*$/;

const inSpans = (spans, start, end) =>
  spans.some(([s, e]) => start < e && end > s);

export function parseRequiredYears(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const found = [];
  const rangeSpans = [];

  // Ranges first — "3-5 years", "3 to 5 years" — the LOWER bound is the bar
  // to clear. Record spans so the single-number pass below doesn't re-read
  // the "5 years" tail of the same range as a separate 5-year requirement.
  const range = /(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/g;
  let m;
  while ((m = range.exec(t))) {
    const lo = +m[1];
    const end = m.index + m[0].length;
    if (
      lo <= 30 &&
      (CTX_AFTER.test(t.slice(end, end + 70)) ||
        CTX_BEFORE.test(t.slice(Math.max(0, m.index - 40), m.index)))
    ) {
      found.push(lo);
    }
    rangeSpans.push([m.index, end]);
  }

  // Single mentions — "5+ years", "five years' experience".
  const single =
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*\+?\s*(?:years?|yrs?)\b/g;
  while ((m = single.exec(t))) {
    if (inSpans(rangeSpans, m.index, m.index + m[0].length)) continue;
    const n = WORD_NUM[m[1]] ?? +m[1];
    const end = m.index + m[0].length;
    if (
      Number.isFinite(n) &&
      n <= 30 &&
      (CTX_AFTER.test(t.slice(end, end + 70)) ||
        CTX_BEFORE.test(t.slice(Math.max(0, m.index - 40), m.index)))
    ) {
      found.push(n);
    }
  }

  if (!found.length) return null;
  // Max, not min: a JD's binding requirement is its largest experience ask
  // ("7+ years of engineering ... 2+ years with SQL" requires 7). The parsed
  // value is shown on the card so a wrong read is visible, not silent.
  return Math.max(...found);
}

// ---------------------------------------------------------------- seniority

// First match wins. `years` is the level's typical minimum ask, used only
// when the description states nothing (null = don't infer: "Lead"/"Manager"
// span everything from a 3-person startup to a 200-person org).
const SENIORITY_RULES = [
  { key: "intern",   label: "Intern",            years: 0,    re: /\bintern(ship)?\b|\bco[- ]?op\b/ },
  { key: "junior",   label: "Junior / New grad", years: 0,    re: /\bjunior\b|\bjr\.?\b|entry[- ]level|new grad|graduate (program|scheme)|early career/ },
  { key: "exec",     label: "VP / Exec",         years: 12,   re: /\bvp\b|vice president|\bhead of\b|\bchief\b|\bpresident\b|general manager/ },
  { key: "director", label: "Director",          years: 10,   re: /\bdirector\b/ },
  // "Associate Principal" (consulting ladder) sits ~senior, not staff+.
  { key: "senior",   label: "Senior",            years: 5,    re: /associate principal/ },
  { key: "staff",    label: "Staff / Principal", years: 8,    re: /\bstaff\b|\bprincipal\b|\bdistinguished\b/ },
  { key: "senior",   label: "Senior",            years: 5,    re: /\bsenior\b|\bsr\.?\b/ },
  { key: "manager",  label: "Manager",           years: null, re: /\bmanager\b|\bmgr\b/ },
  { key: "lead",     label: "Lead",              years: null, re: /\blead\b/ },
];
const MID = { key: "mid", label: "Mid-level", years: null };

export const SENIORITY_ORDER = [
  ["intern", "Intern"],
  ["junior", "Junior / New grad"],
  ["mid", "Mid-level"],
  ["senior", "Senior"],
  ["lead", "Lead"],
  ["manager", "Manager"],
  ["staff", "Staff / Principal"],
  ["director", "Director"],
  ["exec", "VP / Exec"],
];

export function titleSeniority(title) {
  const t = (title || "").toLowerCase();
  for (const r of SENIORITY_RULES) if (r.re.test(t)) return r;
  return MID;
}

// ---------------------------------------------------------------- category

// First match wins — specific GTM/support engineer variants are checked
// before the broad Engineering rule, and "X Operations" titles before
// Operations would otherwise swallow them.
const CATEGORY_RULES = [
  ["Support & CX",          /customer support|technical support|support (engineer|specialist|analyst)|customer experience|customer success|\bcx\b/],
  ["GTM & Sales",           /\bsales\b|account executive|account manager|business development|partnership|go[- ]to[- ]market|\bgtm\b|solutions (engineer|architect|consultant)|pre[- ]?sales|revenue operations/],
  ["People & Talent",       /recruit|\btalent\b|people (ops|operations|partner|team)|human resources|\bhr\b|workplace/],
  ["Finance & Legal",       /financ|accounting|accountant|controller|treasury|legal|counsel|compliance|paralegal|payroll|\btax\b/],
  ["Design",                /designer|design (lead|manager)|\bux\b|\bui\b|user experience|user research|brand design|creative director/],
  ["Data & Analytics",      /data scien|data analyst|analytics|business intelligence|\bbi analyst\b/],
  ["Research",              /research scientist|research engineer|researcher|applied scientist|\bscientist\b|research lead/],
  ["Product",               /product manager|product management|product lead|head of product|product owner|\bapm\b|product operations|product specialist/],
  ["Program & Project Mgmt", /program manager|project manager|\btpm\b|program (lead|management|associate)|project lead/],
  ["Strategy & BizOps",     /strateg|bizops|business operations|chief of staff|corporate development|business analyst/],
  ["Marketing & Comms",     /marketing|communications|\bcontent\b|social media|\bseo\b|public relations|\bbrand\b|\bgrowth\b/],
  ["Operations",            /operations|\bops\b|\boperator\b|logistics|supply chain/],
  ["Engineering",           /engineer|developer|\bswe\b|\bsre\b|devops|programmer|architect/],
  ["IT & Security",         /\bsecurity\b|information technology|it (support|manager|specialist|admin)|helpdesk|sysadmin/],
];

export const CATEGORY_ORDER = [
  "Operations", "Strategy & BizOps", "Product", "Program & Project Mgmt",
  "Data & Analytics", "Research", "Engineering", "GTM & Sales",
  "Marketing & Comms", "Design", "Finance & Legal", "People & Talent",
  "Support & CX", "IT & Security", "Other",
];

export function categorize(title) {
  const t = (title || "").toLowerCase();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  return "Other";
}

// ---------------------------------------------------------------- comp

export function parseCompMax(comp) {
  if (!comp) return null;
  if (/\b(hour|hr|hourly|day|week)\b/i.test(comp)) return null; // not annual
  let max = 0;
  const re = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?/g;
  let m;
  while ((m = re.exec(comp))) {
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (m[2]) n *= 1000;
    else if (n >= 20 && n < 1000) n *= 1000; // bare "150 – 190"
    if (n > max) max = n;
  }
  return max >= 20000 ? max : null;
}

// ---------------------------------------------------------------- enrich

export function enrichJob(j) {
  const sen = titleSeniority(j.title);
  const reqYears = parseRequiredYears(j.description);
  return {
    ...j,
    category: categorize(j.title),
    seniority: sen.key,
    seniorityLabel: sen.label,
    reqYears,
    effYears: reqYears ?? sen.years ?? null,
    compMax: parseCompMax(j.comp),
  };
}

// ---------------------------------------------------------------- filters

export const DEFAULT_FILTERS = {
  categories: {},   // { [category]: 1 (include) | -1 (exclude) }
  seniorities: {},  // { [seniorityKey]: 1 | -1 }
  maxYears: 0,      // 0 = any; N = only roles requiring ≤ N years
  includeUnknownYears: true, // keep roles that state no years requirement
  minCompK: 0,      // 0 = any; N = comp range must reach $N k
  postedDays: 0,    // 0 = any; N = posted within N days
  excludeWords: "", // comma-separated — drop when title contains any
  mustWords: "",    // comma-separated — keep only when title/desc has all
  newOnly: false,   // only jobs first seen in the latest scan
};

const words = (s) =>
  (s || "").toLowerCase().split(",").map((w) => w.trim()).filter(Boolean);

export function countActiveFilters(f) {
  let n = 0;
  n += Object.keys(f.categories || {}).length;
  n += Object.keys(f.seniorities || {}).length;
  if (f.maxYears > 0) n++;
  if (f.maxYears > 0 && !f.includeUnknownYears) n++;
  if (f.minCompK > 0) n++;
  if (f.postedDays > 0) n++;
  n += words(f.excludeWords).length;
  n += words(f.mustWords).length;
  if (f.newOnly) n++;
  return n;
}

export function jobPassesFilters(j, f, newIds) {
  const cm = f.categories || {};
  if (cm[j.category] === -1) return false;
  const catIncludes = Object.keys(cm).filter((k) => cm[k] === 1);
  if (catIncludes.length && !catIncludes.includes(j.category)) return false;

  const sm = f.seniorities || {};
  if (sm[j.seniority] === -1) return false;
  const senIncludes = Object.keys(sm).filter((k) => sm[k] === 1);
  if (senIncludes.length && !senIncludes.includes(j.seniority)) return false;

  if (f.maxYears > 0) {
    if (j.effYears == null) {
      if (!f.includeUnknownYears) return false;
    } else if (j.effYears > f.maxYears) return false;
  }

  // Jobs with no posted comp pass (pair with "Has comp" to require one).
  if (f.minCompK > 0 && j.compMax != null && j.compMax < f.minCompK * 1000) {
    return false;
  }

  if (f.postedDays > 0) {
    if (!j.postedAt) return false;
    if ((Date.now() - new Date(j.postedAt)) / 86400000 > f.postedDays) {
      return false;
    }
  }

  if (f.excludeWords) {
    const hay = (j.title || "").toLowerCase();
    for (const w of words(f.excludeWords)) if (hay.includes(w)) return false;
  }
  if (f.mustWords) {
    const hay = `${j.title} ${j.description}`.toLowerCase();
    for (const w of words(f.mustWords)) if (!hay.includes(w)) return false;
  }

  if (f.newOnly && (!newIds || !newIds.has(j.id))) return false;

  return true;
}
