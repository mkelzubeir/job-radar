#!/usr/bin/env node
/**
 * Verify every board in src/data/companies.json against its ATS API.
 * No dependencies — uses Node's global fetch (Node 18+).
 *
 *   node scripts/verify-boards.mjs          # verify the seed list
 *   node scripts/verify-boards.mjs ashby openai   # ad-hoc: verify one slug
 *
 * Prints HTTP status + job count per company and exits non-zero if any fail.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "src", "data", "companies.json");

const ENDPOINTS = {
  ashby: (slug) =>
    `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
  greenhouse: (slug) =>
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
  lever: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
  smartrecruiters: (slug) =>
    `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`,
  workable: (slug) =>
    `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
  recruitee: (slug) => `https://${slug}.recruitee.com/api/offers/`,
  breezy: (slug) => `https://${slug}.breezy.hr/json`,
};

const countJobs = (ats, ct, data) => {
  if (!data) return 0;
  switch (ats) {
    case "lever":
      return Array.isArray(data) ? data.length : 0;
    case "smartrecruiters":
      return (data.content || []).length;
    case "recruitee":
      return (data.offers || []).length;
    case "breezy":
      // Non-customer subdomains serve marketing HTML; require a JSON array.
      return ct.includes("json") && Array.isArray(data) ? data.length : 0;
    default:
      return (data.jobs || []).length; // ashby, greenhouse, workable
  }
};

async function check(ats, slug) {
  const url = ENDPOINTS[ats]?.(slug);
  if (!url) return { ok: false, status: "?", count: 0, note: `unknown ATS: ${ats}` };
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { ok: false, status: r.status, count: 0 };
    const ct = r.headers.get("content-type") || "";
    const data = ct.includes("json") ? await r.json().catch(() => null) : null;
    const count = countJobs(ats, ct, data);
    // A 200 with zero jobs usually means a dead/misconfigured board slug.
    return { ok: count > 0, status: r.status, count };
  } catch (e) {
    return { ok: false, status: "ERR", count: 0, note: e.message };
  }
}

// Small concurrency pool so we don't hammer the APIs.
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

async function main() {
  // Ad-hoc mode: `node verify-boards.mjs <ats> <slug>`
  const [ats, slug] = process.argv.slice(2);
  if (ats && slug) {
    const res = await check(ats, slug);
    console.log(
      `${res.ok ? "OK  " : "FAIL"}  ${ats}/${slug}  http=${res.status} jobs=${res.count}${res.note ? "  " + res.note : ""}`
    );
    process.exit(res.ok ? 0 : 1);
  }

  const companies = JSON.parse(await readFile(DATA, "utf8"));
  const results = await pool(companies, 6, async (c) => ({ c, ...(await check(c.ats, c.slug)) }));

  const fails = [];
  for (const { c, ok, status, count, note } of results) {
    const line = `${ok ? "OK  " : "FAIL"}  ${(c.name || c.slug).padEnd(16)} ${c.ats.padEnd(15)} ${String(c.slug).padEnd(22)} http=${String(status).padEnd(4)} jobs=${count}${note ? "  " + note : ""}`;
    console.log(line);
    if (!ok) fails.push(c);
  }

  console.log(
    `\n${results.length - fails.length}/${results.length} green` +
      (fails.length ? `  —  ${fails.length} failing: ${fails.map((c) => c.name || c.slug).join(", ")}` : "  — all green ✓")
  );
  process.exit(fails.length ? 1 : 0);
}

main();
