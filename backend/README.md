# Tipster Aggregator — Cloud backend (Amendment E)

The Amendment E backend: a free-Render-hosted Node process that follows
Telegram tipster channels, parses each post into selections, settles them
against key-less ESPN results, scores each **source** by ROI (CLV as the
headline metric), and pushes an FCM notification to your phone the moment a
**rated** source posts. No paid APIs anywhere on this path — see
`docs/AMENDMENT_E.md` for the design and `docs/RUNBOOK.md` for the
step-by-step deploy.

Plain Node.js, no framework, one file per concern, no test-framework
dependency (structured after
[`lumeierecollection-blip/tradeapp`](https://github.com/lumeierecollection-blip/tradeapp)'s
`signal_aggregator/server`, whose shape this directory mirrors exactly:
`server.js` + `lib/*.js` + `test/*.test.js` + `Dockerfile`). The retired
odds-market modules (`lib/odds.js`, `lib/fixtures.js`, `lib/devig.js`,
`lib/edge.js`, `lib/manualCheck.js`, `lib/supabase.js`, `lib/scan.js`,
the `supabase/migrations/` schema, and the `/api/slips`,
`/api/manual-check*`, `/api/strategies` routes) have been removed from the
tree entirely — recoverable from git history — so what remains here is only
live code, the same as `tradeapp`. See `docs/AMENDMENT_E.md`
§"Retired from active service".

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Uptime check. |
| `/api/status` | GET | Scan config, last scan result/error, **loud Telegram state** (session missing/expired is a hard error here, never "no posts"). |
| `/api/sources` | GET | Tracked Telegram sources with their all-window score (ROI, ROI CI low, CLV, hit rate, rated/disqualified + reasons). |
| `/api/posts` | GET | Recent ingested posts (`?limit=`), newest first, with parsed selection counts. |
| `/api/register-device` | POST | Body `{"token", "appInstallId"?, "platform"?}` — registers an FCM token for pushes. |
| `/refresh` | POST | Manual scan trigger; returns the scan summary. |

## How the scan works

1. The server scans every `SCAN_INTERVAL_MS` (default 5 min), guarded
   against overlapping runs (`cache.running`).
2. **Fixtures first** (per `ESPN_LEAGUES`, key-less ESPN scoreboard) so
   verified odds are known *before* a selection is inserted — `selections`
   are immutable after insert, with `verified_odds` written at insert time.
3. **Telegram ingest**: poll each channel since its last message, store
   posts (idempotent on `platform_post_id`), parse picks, insert selections.
4. **Settle** pending selections against ESPN results (matched by
   `provider_event_id`), writing the closing line to the `settlements` row.
5. **Score** every active source (30d/90d/all windows), applying the §7
   disqualifiers (post-kickoff capture rate, claimed-odds inflation,
   post-result posting) — written onto `source_scores`.
6. **Notify**: queue + send pushes for new posts from notifiable sources.

The never-silent rule applies everywhere: every ESPN fetch and Telegram poll
records an `ingestion_health` row, and a missing/expired Telegram session is
reported as a hard error on `/api/status`.

## Run it locally

```bash
npm install
node server.js            # boots with no credentials; /api/status reports what's missing
# then:
curl http://localhost:8080/api/health
curl http://localhost:8080/api/status
```

With no `TELEGRAM_*` env vars the server starts, listens, serves everything,
and reports `telegram.state: "not configured"` on `/api/status` — it never
crashes or pretends.

Run the tests (`node --test`, no test framework dependency, matching
`tradeapp`):

```bash
npm test
```

129 tests: the carried-over settlement and scoring engine (settlement
including every Asian handicap quarter-line case, ROI/CLV/Wilson/bootstrap
scoring) plus the Amendment E modules — `lib/telegram.js` (FloodWait-aware
poller with injected client), `lib/extract.js` (deterministic parser,
synthetic samples in `fixtures/extract/tip_samples.json`), `lib/pipeline.js`
+ `lib/disqualifiers.js` (full end-to-end: ingest → verified odds → settle →
score → notify), `lib/notify.js` (lazy firebase-admin), and a server boot
test (`test/server.test.js`) that spawns the real server with a temp DB and
exercises every route.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port (Render sets `10000` via `render.yaml`). |
| `DB_PATH` | `backend/data/tipster.db` | SQLite file path (persisted on Render's disk). |
| `SCAN_INTERVAL_MS` | `300000` | Scan cadence (5 min). |
| `ESPN_LEAGUES` | `eng.1` | Comma-separated ESPN league slugs to follow. Empty string = no network at all (used by the server test). |
| `TELEGRAM_API_ID` | – | From my.telegram.org. |
| `TELEGRAM_API_HASH` | – | From my.telegram.org. |
| `TELEGRAM_SESSION` | – | Session string from `scripts/make_session.js`. The server also stores its refreshed session in the DB, so this env var is only the bootstrap. |
| `TELEGRAM_CHANNELS` | – | Comma-separated channel usernames to follow (no `@`). Empty = Telegram not polled. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | – | Firebase service-account JSON (multi-line OK). When unset, the server runs everything except push. |

## Deploy

Deploy on Render's free tier with the blueprint at `repo root/render.yaml`
(root directory `backend`, Node runtime, `npm ci`, `node server.js`) — or
with `backend/Dockerfile` on any Docker host. Secrets (`TELEGRAM_*`,
`FIREBASE_SERVICE_ACCOUNT_JSON`) are `sync: false` so they're set in the
Render dashboard, not committed.

Keep the free instance awake with a free UptimeRobot heartbeat on
`/api/health` every 5 minutes (Render sleeps idle free instances, which
would pause the scan loop).

Full walkthrough — including creating the Telegram session, wiring Firebase,
building the APK, and installing it — is in `docs/RUNBOOK.md`.

## Point the Flutter app at it

Rebuild the APK with `--dart-define=API_BASE_URL=<your Render URL>` (see
`.github/workflows/build-apk.yml`, which reads it from the `API_BASE_URL`
repo secret) and reinstall. The app's Slips tab shows `/api/posts`, the
Tipsters tab shows `/api/sources`, and it registers its FCM token via
`/api/register-device` at first launch.
