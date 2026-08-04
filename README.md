# Job Radar

**Scan company career pages directly and rank open roles against your resume.**

Job Radar searches public applicant-tracking-system APIs across a configurable company watchlist, normalizes the results, and ranks each role based on a candidate’s experience.

It runs in the browser and can be deployed as a static site. No account or application backend is required.

## Why I built it

Relevant roles are often buried across individual company career pages and may never appear in a job seeker’s feed at the right time.

Checking those pages manually is slow. Traditional job aggregators also tend to rank roles using generic search terms rather than the candidate’s actual background.

Job Radar turns that process into a repeatable pipeline:

1. Parse a resume.
2. Scan company job boards directly.
3. Normalize postings from different ATS providers.
4. Retrieve the most relevant roles.
5. Rerank the strongest candidates.
6. Explain the fit, gaps, and suggested application angle.

## Core features

### Direct ATS scanning

Job Radar queries the public job-board APIs used by:

* Ashby
* Greenhouse
* Lever
* Recruitee
* SmartRecruiters
* Breezy
* Workable

Each provider exposes a different schema. Job Radar converts the results into a common job format containing fields such as:

* company;
* title;
* location;
* compensation;
* description;
* posting date;
* application URL.

The bundled watchlist includes hundreds of verified company boards and can be edited inside the application.

### Local resume parsing

Users can upload a PDF or paste resume text directly.

The default parsing pipeline runs locally in the browser. It:

* extracts PDF text with `pdf.js`;
* removes contact information and dates;
* identifies weighted keywords and phrases;
* detects likely target titles;
* generates a structured profile for ranking.

Line-aware phrase extraction reduces false matches caused by unrelated terms appearing next to one another in raw PDF output.

### Persistent scans

Completed scans are saved to IndexedDB (a full scan is tens of megabytes — well past the localStorage quota), so the entire result set survives a page refresh and can be re-filtered instantly without rescanning hundreds of boards.

First-seen tracking carries across scans: roles that appear for the first time in the latest scan are tagged **New**, so a rescan surfaces only what has changed since the last one.

### Structured filtering

Every scanned role is classified from its title and description at load time:

* **Role family** — Engineering, Operations, Strategy & BizOps, Product, Program & Project Mgmt, GTM & Sales, and more. Tri-state chips include or exclude whole families, so keyword overlap can no longer surface role types you would never apply to.
* **Seniority** — intern through VP/exec, parsed from the title.
* **Years of experience** — the description's stated requirement ("5+ years of experience", "3–5 years in operations", written numbers included), with range lower bounds treated as the bar to clear. When nothing is stated, seniority implies a floor (Senior ≈ 5, Staff/Principal ≈ 8, Director ≈ 10). A "≤ N years" slider filters on the result, with an option to keep roles that state nothing.
* **Compensation floor**, **posting recency**, **must-mention** and **exclude-title-word** rules round out the set.

Filters persist across sessions and apply to the saved scan — scan once, slice many ways.

### Multi-stage job ranking

Job Radar uses a retrieve-then-rerank architecture. Lightweight methods evaluate the complete job pool before more expensive methods inspect the strongest candidates.

#### Keyword retrieval

Always available, local, and free.

A TF-IDF-style ranker scores every role against the extracted resume profile. Specific and uncommon terms receive more weight than generic language, while title matches receive additional emphasis.

This stage reduces the full scan to a smaller candidate pool.

#### Local semantic ranking

Optional, local, and free.

Job Radar can load a compact MiniLM embedding model through `transformers.js`. Resume and job embeddings are combined with the keyword score to identify relevant roles that use different terminology.

The model is downloaded once and cached by the browser.

#### LLM reranking

Optional and bring-your-own-key.

Claude evaluates the strongest candidates using the full resume and structured profile. It considers:

* seniority;
* domain overlap;
* transferable experience;
* missing qualifications;
* whether the position represents a plausible next step.

Each role receives a fit score and a concise explanation.

## Deep Scan

Deep Scan is the highest-quality ranking path.

Rather than send every full job description to an LLM, it uses a staged cascade:

| Stage      | Purpose                                                |
| ---------- | ------------------------------------------------------ |
| Retrieve   | Combine keyword, semantic, and target-title candidates |
| Screen     | Remove obvious mismatches using compact job data       |
| Deep read  | Evaluate the strongest roles using full descriptions   |
| Tournament | Compare the finalists against one another              |

This structure concentrates inference cost on the roles most likely to matter.

Deep Scan can return:

* reasons for fit;
* material qualification gaps;
* compensation assessment;
* a suggested application angle;
* comparative ranking;
* recommendation tier.

Batching, bounded concurrency, retry handling, and local caching allow the scan to continue when individual requests fail or rate limits occur.

## Privacy

Job Radar has no application backend.

The keyword ranker and optional embedding model operate locally. Resume data does not leave the browser unless the user enables a Claude-powered feature.

When AI features are enabled:

* requests go directly from the browser to the Anthropic API;
* the API key is stored in memory rather than `localStorage`;
* resume text and relevant job information are sent to Anthropic;
* completed results are cached locally to reduce duplicate API calls.

Users can clear the AI cache from the application.

## Architecture

```text
src/
├── lib/
│   ├── ats.js          ATS adapters, normalization, and concurrent scanning
│   ├── resume.js       PDF parsing and local profile extraction
│   ├── match.js        TF-IDF retrieval and scoring
│   ├── embed.js        Local MiniLM semantic ranking
│   ├── ai.js           Claude profile extraction and reranking
│   └── deepscan.js     Multi-stage Deep Scan cascade
├── data/
│   └── companies.json  Verified company-board watchlist
└── App.jsx             Application interface and state management

scripts/
├── discover-boards.mjs Discover and validate additional job boards
└── verify-boards.mjs   Recheck the bundled watchlist
```

### Stack

* React
* Vite
* JavaScript
* `pdf.js`
* Hugging Face `transformers.js`
* Anthropic API
* GitHub Actions
* GitHub Pages

## Operational design

Large-scale scanning introduces several practical problems beyond basic API integration.

### Bounded concurrency

Job Radar scans boards through a concurrency pool rather than sending hundreds of requests simultaneously.

Results stream into the interface as boards resolve. This reduces browser load, limits avoidable request failures, and gives users visible progress during large scans.

### Provider normalization

ATS platforms differ in:

* endpoint structure;
* pagination;
* compensation fields;
* job-description formatting;
* location representation;
* error behavior.

Each adapter converts its provider’s response into the same internal schema. Filtering and ranking therefore operate independently of the original ATS.

### Graceful degradation

Optional features fail independently:

* if the local embedding model cannot load, ranking falls back to keyword retrieval;
* if an AI batch fails, the rest of the cascade continues;
* if browser storage is unavailable or full, the application remains usable without persistence;
* failed company boards are reported without stopping the overall scan.

### Cost control

The application avoids running expensive inference across the entire job pool.

It uses:

* local retrieval before API calls;
* staged candidate reduction;
* compact data during initial screening;
* full descriptions only for finalists;
* result caching keyed to the resume and job.

Users see an estimated cost before running Deep Scan.

## Run locally

```bash
git clone https://github.com/mkelzubeir/job-radar.git
cd job-radar
npm install
npm run dev
```

Open the local Vite URL shown in the terminal.

### Available commands

```bash
npm run build       # Create a production build
npm run preview     # Preview the production build
npm run lint        # Run oxlint
npm run verify      # Verify the bundled company boards
npm run discover    # Discover and rebuild the board watchlist
```

## Add a company

Select the company’s ATS and enter the board slug, usually the final portion of its career-page URL.

### Ashby

```text
jobs.ashbyhq.com/openai
ATS: Ashby
Slug: openai
```

### Greenhouse

```text
boards.greenhouse.io/anthropic
ATS: Greenhouse
Slug: anthropic
```

### Lever

```text
jobs.lever.co/palantir
ATS: Lever
Slug: palantir
```

A failed scan usually means the company changed its slug or migrated to another ATS.

## Discover and verify boards

The bundled company watchlist is maintained through two scripts.

### Discover boards

```bash
npm run discover
```

The discovery script gathers candidate companies, generates likely board slugs, probes supported ATS providers, removes duplicates, and retains verified boards with open positions.

For a smaller run:

```bash
node scripts/discover-boards.mjs --limit 200
```

To inspect results without rewriting the watchlist:

```bash
node scripts/discover-boards.mjs --dry
```

### Verify the watchlist

```bash
npm run verify
```

The verification script checks every saved board and reports its current status and job count.

To probe a single board:

```bash
node scripts/verify-boards.mjs ashby openai
```

## Deploy with GitHub Pages

1. Fork or clone the repository.
2. Push it to GitHub.
3. Open **Settings → Pages**.
4. Set the source to **GitHub Actions**.
5. Push to `main`.

The included workflow builds and deploys the application automatically.

Because the application has no backend, each user supplies their own resume, watchlist, and optional API key. Data is not shared between users.

## Limitations

* Workday does not expose a browser-accessible public API and is not currently supported.
* Company boards can change slugs or ATS providers without notice.
* Resume-to-job scores are prioritization signals, not hiring predictions.
* Compensation availability depends on the source posting.
* LLM-generated rankings can miss non-obvious fit or overvalue language similarity.

## Roadmap

* Workday support through a lightweight serverless proxy
* New-since-last-scan detection
* Saved searches and recurring scans
* An evaluation set for measuring ranking quality
* Improved location and compensation normalization
* Side-by-side comparison of shortlisted roles

## License

MIT
