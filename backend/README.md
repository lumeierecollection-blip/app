# Tipster Aggregator — Cloud backend

Runs the odds-market scan 24/7 in the cloud: polls fixtures (API-Football)
and sharp-book (Pinnacle, via OddsPapi) odds every `SCAN_INTERVAL_MS`,
stores every price snapshot, flags value edges, settles selections once
results exist, and scores strategies by ROI with CLV as the headline
metric. Structured after
[`lumeierecollection-blip/tradeapp`](https://github.com/lumeierecollection-blip/tradeapp)'s
`signal_aggregator/server` (Prompt 8): plain Node.js, no framework, one file
per concern, no test-framework dependency.

This replaces this project's earlier FastAPI + self-run Postgres backend
plan — see `docs/STATUS.md` for why.

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/slips` | GET | Current band A–E slips, from cache. |
| `/api/strategies` | GET | Scored strategies (ROI, ROI CI, CLV, hit rate). |
| `/api/manual-check/fair-price` | GET | Query params `fixture`, `market` → fair prices computed live from the sharp line. |
| `/api/manual-check` | POST | Body `{"fixture", "market", "pick", "offeredOdds", "bookmaker", "line"?}` → edge + stake fraction, logged regardless of outcome. |
| `/api/health` | GET | Uptime check. |
| `/api/status` | GET | Scan config, last scan result/error, pending-settlement count. |
| `/refresh` | POST | Manual trigger; forces a scan. |

## How the scan works

1. The server scans every `SCAN_INTERVAL_MS` (default 5 min), guarded
   against overlapping runs (`cache.running`), same pattern as
   `tradeapp/server.js`'s `scanChain`.
2. Per configured competition: fetch upcoming fixtures, fetch sharp-book
   odds, match them by team name + kickoff proximity, store every snapshot
   (append-only — never overwritten), flag the closing line once a fixture
   kicks off.
3. Report how many selections are waiting on a result. **Settlement itself
   is not automatic yet** — no confirmed API-Football (or other) endpoint
   for finished-fixture scores exists in this project's history, so there
   is no real result source to poll. This is a real, visible gap, not
   hidden behind a fake success.
4. Rescore every active strategy (30d/90d/all windows).
5. Cache the result in memory with a TTL — `/api/slips` and `/api/strategies`
   read the cache, not live from Supabase on every request.

There is no automated soft-book odds scanning (no second book polled
alongside Pinnacle): `/api/manual-check` is the real, primary way a
soft-book price enters this system — not a fallback for a missing scanner
(no confirmed South African bookmaker coverage on the odds API, per
`CLAUDE.md`).

## Run it locally

```bash
npm install
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... API_FOOTBALL_KEY=... ODDS_PROVIDER_API_KEY=... node server.js
# then:
curl http://localhost:8080/api/health
curl http://localhost:8080/api/status
```

`/api/health`, `/api/status`, and the root endpoint work with no
credentials at all — the scan fails gracefully into `lastScanError`
instead of crashing the process (verified locally: with no keys set, the
server starts, listens, and reports the real error through `/api/status`
rather than throwing).

Run the tests (`node --test`, no test framework dependency, matching
`tradeapp`):

```bash
npm test
```

114 tests: pure math (de-vig, edge detection, settlement including every
Asian handicap quarter-line case, ROI/CLV/Wilson/bootstrap scoring) and
provider parsing tests replayed against the real captured OddsPapi payload
from this project's Task B1b (`fixtures/provider_probes/oddspapi_odds_pinnacle.json`)
— not synthetic data. `lib/supabase.js` and the scan orchestration in
`lib/scan.js` are thin glue over already-tested modules and are **not**
independently tested here — they need a real Supabase project, which
this sandbox doesn't have.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port (Cloud Run injects `PORT=8080`). |
| `CACHE_TTL_MS` | `600000` | How long `/api/slips`/`/api/strategies` are served without re-scanning. |
| `SCAN_INTERVAL_MS` | `300000` | How often the server scans on its own (5 min). |
| `COMPETITIONS` | `Premier League` | Comma-separated competition names to poll. |
| `SUPABASE_URL` | – | Required. Your Supabase project URL. |
| `SUPABASE_SERVICE_KEY` | – | Required. The **service role** key (server-side only — never ship this to the Flutter app). |
| `API_FOOTBALL_KEY` | – | Required to scan. |
| `ODDS_PROVIDER_API_KEY` | – | Required to scan. OddsPapi key. |

## Supabase setup

1. Create a free project at https://supabase.com.
2. In the SQL editor, run `supabase/migrations/20260813000001_schema.sql`
   (or install the Supabase CLI and run `supabase db push` from this
   directory).
3. Copy the project URL and the **service_role** key (Settings → API) —
   these are `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.

## Deploy to Google Cloud Run (free tier, nothing installed on your PC)

You need a free Google account. Use **Google Cloud Shell** (browser
terminal at https://shell.cloud.google.com — no downloads). Cloud Run needs
a billing account on the project; the free tier (2M requests/mo, 240k
vCPU-seconds/mo) is comfortably enough for a scan every 5 minutes.

```bash
git clone https://github.com/YOURUSER/YOURREPO.git
cd YOURREPO/backend

gcloud projects create tipster-aggregator-backend --name="Tipster Aggregator Backend"
gcloud config set project tipster-aggregator-backend
# attach a billing account: https://console.cloud.google.com/billing/link
gcloud services enable run.googleapis.com

gcloud run deploy tipster-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --memory 512Mi --cpu 1 \
  --set-env-vars "SUPABASE_URL=...,SUPABASE_SERVICE_KEY=...,ODDS_PROVIDER_API_KEY=...,API_FOOTBALL_KEY=..."

# prints a Service URL like https://tipster-backend-xxxx.a.run.app — copy it
```

Since Cloud Run scales to zero when idle, that's fine for a personal app —
requests wake it. Don't set `--min-instances 1` unless idle latency
actually bothers you; it costs more for no real benefit here.

Never paste Supabase or provider keys into a shared/logged shell history —
same discretion as this project's Android keystore handling.

## Point the Flutter app at it

Rebuild the APK with `--dart-define=API_BASE_URL=<your Cloud Run URL>` (see
`.github/workflows/build-apk.yml`, which reads this from the `API_BASE_URL`
repo secret) and reinstall. The Health screen should go green against the
real deploy.
