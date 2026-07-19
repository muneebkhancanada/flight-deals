# Kuwait International Airport (KWI) Operations Monitor

A public operations dashboard for Kuwait International Airport, focused on
operational disruption: airspace restrictions, airport closures, airline
suspensions, cancellations, diversions and major delays.

Runs as **one Cloudflare Worker** that serves the static frontend, collects
aviation data in the background, persists normalized snapshots to **KV**, and
serves them via JSON APIs with stale-while-revalidate semantics — so the
dashboard keeps working (on the last good snapshot) even when upstream
sources fail.

**Coverage:** completed movements from the last **12 hours** plus all
published flights for the next **96 hours**.

---

## Architecture

```
public/               Static frontend (plain HTML/CSS/vanilla JS)
  index.html          Dashboard shell (tabs, banner, summary cards)
  app.js              Rendering, search/filter/sort, tab logic
  styles.css          Responsive styles (table → cards on mobile)
src/
  worker.js           Worker entry: routes, asset serving, cron handler
  config.js           Non-secret configuration (airlines, sources, vars)
  util.js             Timeouts, time conversion, sanitisation
  flights.js          Dedupe, 12h/96h window filter, summary counts
  presentation.js     Operational display rules (tones, labels)
  airspace.js         Airspace status determination
  snapshot.js         Guarded refresh orchestration + KV persistence
  alerts.js           Optional email alerting (Resend) with dedupe
  sources/
    kwiFlights.js     Official KWI combined arrivals/departures API
    notams.js         Kuwait NOTAM ingestion + passenger-impact filtering
    advisories.js     Airline / DGCA advisory page monitoring
    social.js         Optional official X account ingestion
test/run-tests.js     Acceptance test suite (plain Node, no framework)
scripts/validate.js   Syntax checks + config check + tests (npm run check)
wrangler.jsonc        Wrangler configuration template
INSTALL-AND-DEPLOY.cmd  Windows one-shot validate + deploy script
```

### Data flow

1. A refresh (cron every 5 min, or on-demand when `/api/status` finds the
   snapshot older than `ON_DEMAND_REFRESH_SECONDS`) collects all sources with
   `Promise.allSettled` — each source fails independently and has its own
   `AbortController` timeout.
2. The official KWI API is fetched **once** per refresh (it returns arrivals
   and departures combined) and parsed once.
3. Results are normalized, de-duplicated (official data wins), windowed,
   given display metadata, and written to KV as one snapshot.
4. `/api/status` always returns the latest KV snapshot immediately; if it is
   stale it starts a **background** refresh via `ctx.waitUntil()`. An
   in-isolate guard (`activeRefreshPromise`) prevents overlapping refreshes.
5. If the flight feed fails, the last good flight list is served with
   `dataMode: "cached-degraded"` — the dashboard says the feed is degraded
   and **never** claims "zero flights operating" because a source broke.

## API

| Endpoint | Behaviour |
| --- | --- |
| `GET /api/status` | Full normalized snapshot. Served from KV immediately; background refresh when stale. `Cache-Control: public, max-age=20, stale-while-revalidate=120`. |
| `GET /api/health` | Lightweight: Worker status, KV availability, snapshot age, last refresh error. Reads only a small meta blob — never triggers a refresh. |
| `POST /api/refresh` | Optional manual refresh. Requires `Authorization: Bearer <ADMIN_TOKEN>`. Responds 404 when `ADMIN_TOKEN` is not configured. |

## Setup

### Prerequisites

- Node.js 18+ (20+ recommended)
- A Cloudflare account (free tier is sufficient)

### 1. Install dependencies

```sh
npm install
npx wrangler login
```

### 2. Create the KV namespace

```sh
npx wrangler kv namespace create KWI_KV
```

Copy the printed `id` into `wrangler.jsonc`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 3. Configure secrets

Only `KWI_API_AUTH` is required; everything else is optional.

```sh
# REQUIRED — the Authorization header value for the official KWI flight API.
npx wrangler secret put KWI_API_AUTH

# OPTIONAL — enables POST /api/refresh
npx wrangler secret put ADMIN_TOKEN

# OPTIONAL — enables the Official Posts tab (X API v2 bearer token)
npx wrangler secret put X_BEARER_TOKEN

# OPTIONAL — enables email alerts via Resend
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ALERT_EMAIL_TO      # comma-separated recipients
npx wrangler secret put ALERT_EMAIL_FROM    # verified sender address
```

For **local development**, put the same values in a `.dev.vars` file (already
gitignored — never commit it):

```
KWI_API_AUTH=Bearer eyJ...
ADMIN_TOKEN=some-long-random-string
```

Secrets never appear in the frontend, in API responses, in logs, or in the
committed source — the test suite verifies the frontend files.

### 4. Local development

```sh
npm run dev          # wrangler dev → http://localhost:8787
npm run check        # syntax checks + config check + acceptance tests
npm test             # acceptance tests only
```

`wrangler dev` provides a local KV simulation. Trigger the cron handler
locally with: `curl "http://localhost:8787/cdn-cgi/handler/scheduled"` (or
just hit `/api/status`, which starts a refresh when no snapshot exists).

### 5. Deploy

```sh
npm run check        # never deploy without green validation
npm run deploy       # npx wrangler deploy
```

Wrangler prints the deployed URL (`https://kwi-operations-monitor.<your-subdomain>.workers.dev`).

### Windows one-shot deploy

Place the project at `C:\kwi-operations-monitor-deploy-ready` and run
`INSTALL-AND-DEPLOY.cmd`. It backs up the existing deployment, copies new
files (handling the extracted-in-place case), runs `npm.cmd run check` and
`node --check public\app.js`, and only deploys when validation passes.

## Configuration variables (non-secret, in `wrangler.jsonc`)

| Var | Default | Meaning |
| --- | --- | --- |
| `ON_DEMAND_REFRESH_SECONDS` | `90` | Snapshot age that triggers a background refresh on `/api/status` |
| `FLIGHT_HISTORY_HOURS` | `12` | Completed-movement lookback |
| `FLIGHT_FUTURE_HOURS` | `96` | Future-flight horizon |
| `KWI_TIMEZONE` | `Asia/Kuwait` | Display timezone (fixed UTC+3) |

Add airlines to the advisory monitor by extending `ADVISORY_SOURCES` in
`src/config.js`; add X accounts via `X_ACCOUNTS`.

## Data sources & fallback behaviour

| Source | Type | Automated? | On failure |
| --- | --- | --- | --- |
| Kuwait International Airport flight API | Official JSON (primary) | Yes — requires `KWI_API_AUTH` | Last good flight list served, `dataMode: cached-degraded`, feed marked unavailable. Never rendered as "no flights". |
| Kuwait DGCA NOTAMs | Via FAA NOTAM Search (OKKK/OKBK) | Yes, best-effort, no credential | Last known notices reused for airspace analysis; source marked degraded. |
| Airline advisory pages | HTML keyword scan | Yes, best-effort (CMS pages may block bots) | Per-page isolation; page marked degraded; official links always shown. |
| Official X posts | X API v2 (single search call per refresh) | Only when `X_BEARER_TOKEN` set | Tab and health card hidden entirely when unconfigured; last posts reused on transient errors. |
| Email alerts | Resend API | Only when configured | Marked "not configured" in `/api/health` only — never a public error. |

**Airspace status** is determined from (1) DGCA/government notices,
(2) NOTAMs (an active FIR/airport-closure NOTAM is decisive), (3) observed
official flight activity as supporting evidence, (4) airline advisories.
A broken flight feed yields **unknown**, never **closed**.

## Email alerts (optional)

When Resend is configured, a refresh that detects any of the following sends
one combined email with subject **"KWI flight disruption alert"**:
new cancellation, new diversion, delay crossing 2 hours, airspace/airport
restriction change, possible airline suspension advisory, or an unusually
broad rise in disrupted flights. Every event has a deterministic fingerprint
stored in KV for 3 days, so unchanged conditions never re-alert.

## Backup and rollback

**Cloudflare versioned rollback (recommended):**

```sh
npx wrangler deployments list          # find the previous deployment/version
npx wrangler rollback                  # roll back to the prior deployment
# or: npx wrangler rollback --version-id <id>
```

**File-level backup:** the Windows installer writes a timestamped
`backup-YYYYMMDD-HHMMSS` folder next to the project before every update; to
roll back, restore that folder over the project and re-run the installer.

**KV data:** snapshots are disposable operational caches — after a rollback
the next refresh rebuilds them. To export first:
`npx wrangler kv key get snapshot:latest --binding KWI_KV --remote > snapshot-backup.json`.

## Frontend cache-busting

`index.html` references `app.js?v=__ASSET_VERSION__` and
`styles.css?v=__ASSET_VERSION__`; the Worker substitutes `ASSET_VERSION`
from `src/config.js` at serve time and marks versioned assets immutable.
**Bump `ASSET_VERSION` whenever you change `public/app.js` or
`public/styles.css`.**

## Security notes

- All secrets live in Cloudflare secrets / `.dev.vars`; nothing secret is in
  the repo, the frontend, or API responses (verified by tests).
- All externally supplied text is sanitised server-side (tags/control chars
  stripped, length-capped) **and** HTML-escaped client-side before insertion.
- Outbound links are restricted to `http(s):` in both backend and frontend.
- Responses carry a strict CSP (`default-src 'self'`, no inline script),
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, referrer and
  permissions policies.
- `POST /api/refresh` requires the `ADMIN_TOKEN` secret (constant-time
  comparison) and is invisible (404) when unconfigured.

## Honest-data principles

- A failed source is a monitoring event, not an operational event: the UI
  says "feed unavailable/degraded", never "no flights operating".
- A delayed flight that eventually departed shows **"Departed 18:05" +
  "40 min late"** (amber; red at ≥2h) — completed movement takes precedence
  over the delay flag, and lateness never turns green.
- Routine NOTAMs (cranes, rigs, stands, minor taxiway work, chart
  amendments, isolated lighting) are analysed but not displayed.
- Unofficial X posts are labelled and cross-checked against official data.

## Disclaimer

This is an unofficial monitoring tool. Always confirm flight and airspace
status with your airline, [kuwaitairport.gov.kw](https://www.kuwaitairport.gov.kw)
and [Kuwait DGCA](https://www.dgca.gov.kw) before travelling.
