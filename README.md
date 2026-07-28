# Job Radar

**Upload a resume. Scan the hidden job boards of any company you care about. Get every open role ranked against you.**

Most great roles never hit LinkedIn feeds or job aggregators in time. They live on company career portals hosted by applicant tracking systems (ATS) like Ashby, Greenhouse, and Lever. Job Radar queries those portals directly through their public JSON APIs, then scores each posting against your resume, entirely in the browser.

## What it does

1. **Resume parsing.** Drop in a PDF (parsed with pdf.js) or plain text. The app extracts weighted keywords and phrases locally. Your resume never leaves your device — there is no backend.
2. **Board scanning.** For every company on your watchlist, Job Radar hits the public job board API for that company's ATS and normalizes postings into one shape: company, title, location, compensation, description, posting date, apply link.
3. **Ranking.** Each job gets a 0–100 match score. Title matches are weighted 4x over description matches; multi-word phrases from your resume count more than single keywords. You can also pin target titles that get boosted further.
4. **Filtering.** Remote-only, has-compensation, minimum match score, and free-text filters.

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
- Optional LLM-based ranking (resume vs. full job description) with a user-supplied API key
- New-since-last-scan diffing and notifications
- Export shortlist to CSV

## License

MIT
