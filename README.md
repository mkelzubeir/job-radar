# Job Radar

**Upload a resume. Scan the hidden job boards of any company you care about. Get every open role ranked against you.**

Most great roles never hit LinkedIn feeds or job aggregators in time. They live on company career portals hosted by applicant tracking systems (ATS) like Ashby, Greenhouse, and Lever. Job Radar queries those portals directly through their public JSON APIs, then scores each posting against your resume, entirely in the browser.

## What it does

1. **Resume understanding.** Drop in a PDF (parsed with pdf.js) or plain text. By default the app extracts weighted keywords locally: it strips contact info and dates, then builds unigrams and **line-aware bigrams** — phrases are only formed *within* a line/segment, so `M.S. Information Science, Princeton` no longer yields junk like "science princeton". With an Anthropic API key, **AI profile extraction** takes over as the primary path: one Claude call returns a structured profile (weighted skills, domains, likely next titles, seniority, years of experience, a short summary), which becomes your keyword chips and auto-fills target titles. Either way, nothing leaves your device unless you opt into an AI feature.
2. **Board scanning.** For every company on your watchlist, Job Radar hits the public job board API for that company's ATS and normalizes postings into one shape: company, title, location, compensation, description, posting date, apply link. The seed watchlist is **verified live** — run `npm run verify` to re-check every board (see below).
3. **Ranking — retrieve, then rerank (three tiers).** Job Radar uses the standard retrieval-and-rerank pattern: a cheap pass narrows the field, then progressively better rankers order the survivors. Each tier is optional-additive; Tier 1 always runs.
   - **Tier 1 — retrieval (TF-IDF, always on, local & free).** A keyword overlap runs over the *entire* scan. Every keyword is weighted by how rare it is across the scanned jobs (`idf = ln(1 + N/(1+df))`), so ubiquitous terms like "data" or "team" contribute almost nothing while rare, specific terms dominate. Title matches count 4× description matches; optional target titles add exact/partial-credit boosts. Scores normalize so **100 = the best fit in today's scan**. This tier selects the top-N candidates (default 60, adjustable 20–150).
   - **Tier 2 — local embeddings ("Semantic boost", optional, no key).** Toggle it on and Job Radar lazy-loads a small MiniLM sentence-embedding model (`Xenova/all-MiniLM-L6-v2`, ~25 MB, downloaded once and cached by the browser) via transformers.js. It embeds your résumé and the top ~400 candidates and blends `0.5 · cosine + 0.5 · normalized TF-IDF` into the keyword-stage score — semantic matching with **zero API cost**. If the model fails to load it falls back silently to TF-IDF.
   - **Tier 3 — LLM rerank ("Smart rank", optional, API key).** Paste your own Anthropic API key and Claude scores the top-N candidates against your **full résumé text plus the structured profile** — judging seniority match, domain overlap, transferable skills, and trajectory (a sensible next role, not just keyword overlap) — returning a 0–100 fit score and a one-line reason per job. When present, the AI score becomes the primary ranking and the keyword score is demoted to a secondary badge.
   - **Deep Scan — the maximum-quality cascade (optional, API key, expensive by design).** For when you want the best possible shortlist and are willing to spend credits. A four-stage cascade — see below.
4. **Filtering.** Remote-only, has-compensation, minimum score (applied to whichever score is primary), and free-text filters.

### Deep Scan — retrieve → screen → deep read → tournament

Deep Scan is the deliberately expensive path: it spends real API credits to get a hand-recruiter-quality shortlist. Every call uses `claude-sonnet-5`, direct from the browser. The cascade is designed so cost is spent where it matters — breadth first with cheap passes, depth only on the survivors:

| Stage | What it does | Scope | Cost |
|---|---|---|---|
| **0 · Pool** | Union of the top 1500 by TF-IDF, top 1500 by local embeddings (if Semantic boost ran), and every job whose title matches a target title. Deduped. | ~up to 2000 jobs | Local, free |
| **1 · Screen** | Claude scores the whole pool (compact job data) to kill obvious non-fits. Batches of ~40, 4 concurrent, 429-backoff. | pool → **top 150** | Cheap-ish |
| **2 · Deep read** | Full job descriptions (~4000 chars) + your **full résumé**. Returns score, `fit_reasons`, `gaps`, `comp_check`, and an `apply_angle` per job, with instructions to be skeptical (scores > 85 are rare). Batches of ~8, 3 concurrent. | 150 → survivors | The bulk of the spend |
| **3 · Tournament** | One comparative call ranks the **top 30** against each other for *you specifically* (absolute scores drift between batches; comparison fixes it), assigning a rank + tier. | top 30 | One call |

Results are presented in three tiers — **Apply now**, **Strong**, **Worth a look** — each card showing rank, fit score, `fit_reasons` (bullets), `gaps` (muted), the `apply_angle` (italic), and a `comp_check` badge. Everything outside the shortlist stays keyword-ranked below. **"Download shortlist (CSV)"** exports the tiered results (company, title, location, comp, tier, rank, score, apply_angle, url).

**Cost.** You see a rough estimate (from pool size and token accounting) and confirm **before** anything runs. As a ballpark, a full scan pool of ~1500–2000 jobs runs on the order of a few US dollars, dominated by Stage 2's full-description reads. Every stage output is **cached in `localStorage` by résumé-hash + job id**, so an interrupted or re-run Deep Scan only pays for what's new. Per-batch failures are non-fatal — the cascade keeps going and notes what was skipped.

### AI features — privacy & cost

Tier 1 and Tier 2 are **fully local** (Tier 2 downloads a model but runs inference in your browser — no data leaves the device). The Claude-powered features (AI profile extraction, Smart rank, and Deep Scan) are the **only** ones that send data off your device:

- Requests go **directly from your browser to the Anthropic API** — there is still no backend.
- Your API key is held in **memory only** (React state), never written to `localStorage`.
- In these modes your **full résumé text** — and a view of the candidate jobs (Smart rank: first ~800 chars of description; Deep Scan Stage 2: up to ~4000 chars) — are sent to Anthropic.
- Results are cached locally, keyed to your résumé, so re-runs and reloads don't re-bill; **"Clear AI cache"** resets the profile, Smart-rank scores, and all Deep Scan stage caches.

## Supported ATS platforms

Every platform below exposes a public, **CORS-enabled** per-company JSON endpoint intended for embedding job boards — verified from a browser context. No keys, no scraping, no rate-limit games. Seed counts are from the last `npm run discover` run.

| Platform | Endpoint | CORS | Compensation | Seed |
|---|---|---|---|---|
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` | ✅ `*` | Structured (`compensationTierSummary`) | 382 |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | ✅ | Extracted from description text | 110 |
| Lever | `api.lever.co/v0/postings/{slug}` | ✅ | Structured (`salaryRange`) when present, else extracted | 39 |
| Recruitee | `{slug}.recruitee.com/api/offers/` | ✅ (reflects origin) | Structured (`salary`) when present | 2 |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{slug}/postings` | ✅ | Not in list endpoint | 2 |
| Breezy | `{slug}.breezy.hr/json` | ✅ `*` | `salary` field when present | 2 |
| Workable | `apply.workable.com/api/v1/widget/accounts/{slug}` | ✅ | Extracted from description text | 1 |

**538 verified companies** total. Ashby dominates because it's the ATS of choice for the YC/AI-startup cohort the discovery pipeline draws from.

### Platforms evaluated but not included

| Platform | Why not |
|---|---|
| **Personio** (`{slug}.jobs.personio.de/search.json`) | Aggressive server-side rate-limiting — returns `429` to programmatic requests even when spaced seconds apart — and sends **no CORS headers**, so it can't be called from a browser. |
| **Workday** | No public cross-origin API at all; can't be queried from a static client-side app. The main item on the roadmap below. |

## Architecture

```
src/
  lib/
    ats.js      7 ATS adapters → normalized job shape + bounded-concurrency scanner
    resume.js   pdf.js text extraction + line-aware keyword/phrase weighting
    match.js    Tier 1 — TF-IDF retrieval and scoring
    embed.js    Tier 2 — local MiniLM embeddings (lazy, code-split)
    ai.js       Tier 3 — Claude profile extraction + Smart-rank scoring
    deepscan.js Deep Scan — 4-stage retrieve→screen→deep-read→tournament cascade
  data/
    companies.json   verified seed watchlist (editable in-app, persisted to localStorage)
  App.jsx       UI: upload, watchlist manager, streaming scan, three-tier ranked results
scripts/
  discover-boards.mjs   build-time company discovery (npm run discover)
  verify-boards.mjs     live board checker (npm run verify)
```

Static React app (Vite). State persists in localStorage (best-effort — a huge watchlist that exceeds the quota degrades gracefully to no-persistence). transformers.js and the embedding model are dynamically imported so they stay out of the main bundle. Deploys to GitHub Pages via the included workflow.

### Scanning at scale

`scanCompanies` runs boards through a **bounded concurrency pool** (default 12 in flight) rather than firing hundreds of `fetch`es at once, and **streams results into the UI** as each board resolves (flushed ~every 400 ms) so a large scan fills in progressively while the scan button shows live `done/total` progress. The company panel has a filter box (the list can be hundreds long), and the errors panel collapses to an "N boards failed" summary you can expand.

## Run it

```bash
npm install
npm run dev
```

## Company discovery & verification

The bundled watchlist in `src/data/companies.json` is **generated and verified** by two maintainer scripts — the app itself ships only the static JSON.

**Discover** — probe public sources and rebuild the list:

```bash
npm run discover              # full run (rewrites companies.json)
node scripts/discover-boards.mjs --limit 200   # probe first 200 candidates
node scripts/discover-boards.mjs --dry         # report only, don't write
```

It pulls candidate companies from the [YC company directory](https://github.com/yc-oss/api) (filtered to those actively hiring) plus a public GitHub list of ATS board URLs, generates slug guesses (YC slug, website domain, cleaned/dashed name), and probes Ashby → Greenhouse → Lever live through a concurrency pool (first verified hit with open jobs wins). Recruitee/Breezy boards come from the GitHub list and a small curated set. Results merge with the existing verified seed (deduped by `ats:slug`, existing names preferred), 0-job boards are dropped, and it prints per-ATS counts.

**Verify** — re-check every board in the current list:

```bash
npm run verify
```

Prints each board's HTTP status and open-job count and exits non-zero if any board 404s or returns zero jobs. Probe one ad-hoc board with `node scripts/verify-boards.mjs ashby openai`.

To refresh the watchlist: `npm run discover`, then `npm run verify` to confirm it's 100% green, then commit the updated `companies.json`.

## Deploy your own (free)

1. Fork or clone this repo, push to GitHub.
2. In repo settings → Pages, set Source to **GitHub Actions**.
3. Push to `main`. The included workflow builds and deploys automatically.

Anyone with the URL can use it with their own resume and their own company watchlist — nothing is shared between users because nothing is stored server-side.

## Adding companies

In the app, add a company by picking its ATS and entering its board slug — the last part of its careers URL:

- `jobs.ashbyhq.com/openai` → ATS: Ashby, slug: `openai`
- `boards.greenhouse.io/anthropic` → ATS: Greenhouse, slug: `anthropic`
- `jobs.lever.co/palantir` → ATS: Lever, slug: `palantir`

If a scan shows an error for a company, the slug is usually wrong or the company changed ATS providers.

## Roadmap

- Workday support via a small serverless proxy
- New-since-last-scan diffing and notifications
- Export shortlist to CSV

## License

MIT
