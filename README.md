# Job Radar

**Upload a resume. Scan the hidden job boards of any company you care about. Get every open role ranked against you.**

Most great roles never hit LinkedIn feeds or job aggregators in time. They live on company career portals hosted by applicant tracking systems (ATS) like Ashby, Greenhouse, and Lever. Job Radar queries those portals directly through their public JSON APIs, then scores each posting against your resume, entirely in the browser.

## What it does

1. **Resume parsing.** Drop in a PDF (parsed with pdf.js) or plain text. The app extracts weighted keywords and phrases locally. Your resume never leaves your device — there is no backend.
2. **Board scanning.** For every company on your watchlist, Job Radar hits the public job board API for that company's ATS and normalizes postings into one shape: company, title, location, compensation, description, posting date, apply link.
3. **Ranking — retrieve, then rerank.** Job Radar uses the standard modern two-stage pattern: a cheap retrieval pass narrows the field, then an expensive ranker orders the survivors.
   - **Stage 1 — retrieval (TF-IDF, always on).** A keyword overlap runs over the *entire* scan. Every resume keyword is weighted by how rare it is across the scanned jobs (`idf = ln(1 + N/(1+df))`), so ubiquitous terms like "data" or "team" contribute almost nothing while rare, specific terms dominate. Title matches count 4× description matches; optional target titles add exact/partial-credit boosts. Scores normalize so **100 = the best fit in today's scan**. This stage's job is to select the top-N candidates (default 60, adjustable 20–150) — fast, local, and free.
   - **Stage 2 — ranking (LLM, "Smart rank").** Paste your own Anthropic API key and Claude scores those top-N candidates against your **full résumé text** — judging seniority match, domain overlap, transferable skills, and trajectory (a sensible next role, not just keyword overlap) — returning a 0–100 fit score and a one-line reason per job. When present, the AI score becomes the primary ranking and the keyword score is demoted to a secondary badge. This is the main ranking; keyword ranking is the fallback when no key is provided. See the privacy and cost notes below.
4. **Filtering.** Remote-only, has-compensation, minimum score (applied to whichever score is primary), and free-text filters.

### Smart rank — privacy & cost

Smart rank (Stage 2) is the **only** feature that sends data off your device. When you use it:

- The request goes **directly from your browser to the Anthropic API** — there is still no backend.
- Your API key is held in **memory only** (React state), never written to `localStorage`.
- In this mode your **full résumé text** and a compact view of the candidate jobs (title, company, location, comp, and the first ~800 chars of each description) are sent to Anthropic so the model can judge fit.
- Rough **cost scales with the candidate count** — jobs are scored ~20 per request. Results are cached locally (keyed to your résumé) so re-scans and reloads don't re-bill; "Clear AI cache" resets that.

Stage 1 and everything else in the app remain fully local.

## Supported ATS platforms

| Platform | Endpoint | Compensation data |
|---|---|---|
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}` | Structured (`compensationTierSummary`) |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | Extracted from description text |
| Lever | `api.lever.co/v0/postings/{slug}` | Structured (`salaryRange`) when present, else extracted |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{slug}/postings` | Not in list endpoint |
| Workable | `apply.workable.com/api/v1/widget/accounts/{slug}` | Extracted from description text |

All endpoints are public and CORS-enabled — they exist so companies can embed their own boards. No keys, no scraping, no rate-limit games.

> Workday is deliberately absent: it has no public cross-origin API, so it can't be queried from a static client-side app. It's the main item on the roadmap below.

## Architecture

```
src/
  lib/
    ats.js      ATS adapters → normalized job shape
    resume.js   pdf.js text extraction + keyword/phrase weighting
    match.js    scoring and ranking
  data/
    companies.json   seed watchlist (editable in-app, persisted to localStorage)
  App.jsx       UI: upload, watchlist manager, scan, ranked results
```

Static React app (Vite). State persists in localStorage. Deploys to GitHub Pages via the included workflow.

## Run it

```bash
npm install
npm run dev
```

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
