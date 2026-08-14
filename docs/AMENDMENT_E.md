# Amendment E — the no-API path: Telegram + ESPN + push notifications

Status: **designed, not yet built.** This is the plan the user asked for in
Prompt 9 ("cloud based, runs without my PC, notify when a slip from a trusted
provider appears, no APIs"). It replaces the odds-market premise (Amendment B,
OddsPapi + API-Football keys + Supabase) as the **primary** backend with a
server that needs no paid or registered third-party APIs at all. The old path
stays in git history, fully recoverable, exactly as the Python backend was.

## The goal

A single Node server on a free cloud host that:

1. Runs 24/7 without the user's PC being on.
2. Follows tipster Telegram channels (the user's chosen sources).
3. Parses each post into selections, snapshots `captured_at` itself.
4. Settles selections against real match results, using only key-less,
   public data.
5. Scores each source with the existing, already-proven scoring engine
   (`backend/lib/scoring.js` — §7 ROI, bootstrap CI, `roi_ci_low`,
   50-settle gate, CLV).
6. **Pushes a phone notification the moment a *rated* source posts** (rated =
   ≥50 settled selections with `roi_ci_low > 0`), via Firebase Cloud
   Messaging to the existing Flutter app.

## What the user decided (Prompt 9 answers)

| Question | Decision |
|---|---|
| Slip source | Telegram channels **and** public odds/data scraping (no paid keys) |
| "Trusted" | ROI-rated by the engine (≥50 settled, positive ROI) — notifications gate on this |
| Notifications | Push to the Flutter app (FCM) |
| Host + storage | Render free tier + local DB (SQLite) |

## Data sources — all key-less, all live-confirmed 2026-08-14

### ESPN public scoreboard endpoint (fixtures + results + DraftKings odds)

Confirmed working from this session's sandbox (real egress now exists):

```
GET https://site.api.espn.com/apis/site/v2/sports/soccer/<league>/scoreboard
GET https://site.api.espn.com/apis/site/v2/sports/soccer/<league>/scoreboard?dates=YYYYMMDD
```

- **No key, no registration, no cookie.** Plain JSON, CORS-open.
- Returns fixtures (`id`, `date`, teams, `status`), **full-time results**
  (`STATUS_FULL_TIME`, per-team `score`, and a `details` array of goal
  events), and **DraftKings odds** (`competitions[].odds`): moneyline,
  over/under, and spread, each with an `open` and a `close` line.
- Live-proven this session: EPL `eng.1` returned a scheduled 2026-08-21
  fixture with full DraftKings odds (ML open/close −750/−600 for the
  favourite); `usa.1?dates=20260808` returned a finished match
  (NE 0-2 HOU, `STATUS_FULL_TIME`, 4 detail events).

This one endpoint replaces both paid providers:

| Old (Amendment B) | New (Amendment E) |
|---|---|
| OddsPapi → Pinnacle sharp lines | DraftKings odds via ESPN (soft-book line with open/close) |
| API-Football fixtures | ESPN fixtures |
| API-Football results (never actually built — no confirmed endpoint) | ESPN full-time results — **built this time**, endpoint confirmed |

**Honest caveats:**

- **The sharp-reference premise dies.** DraftKings via ESPN is a soft book,
  not Pinnacle. The de-vig/edge math (`devig.js`, `edge.js`) is **not**
  wired into this path — there is no "find a soft-book edge" step. Instead
  the engine verifies what a source *claimed* (claimed odds vs the
  DraftKings line at capture) and grades the source by settled ROI. CLV is
  computed against the DraftKings `close` line (closing-line value still
  works with any book's line). The old sharp-book math stays in git.
- **South African bookmaker coverage:** ESPN's soccer coverage is global
  but leagues outside the big competitions are thin. Expect **no**
  SA-bookmaker odds line; claimed-odds verification for an SA book will
  likely be null and the score will rest on claimed odds alone. The
  `verified_odds` column is optional by design (`odds_used = verified_odds
  if present else claimed_odds`). Configure the leagues you actually bet
  on; verify each `/<league>` slug live before trusting it.
- **ESPN is a consumer website, not a contract.** It changes shape; the
  adapter must parse defensively and record every fetch in
  `ingestion_health`, same as the old providers.

### Telegram (sources)

- **grammJS** (`telegram` npm package, v2.26.22, Node ≥20) — pure-JS
  MTProto client, no API key, matches the Node backend language (the old
  deferred path used Python Telethon via `deferred_social/cli_runner.py`,
  which stays untouched).
- Needs `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` from my.telegram.org
  (free, one-time) and a `StringSession` created once from a phone number
  the user controls. The session string is passed via env
  `TELEGRAM_SESSION` and re-written to the DB as it refreshes.
- Tracked channels: `TELEGRAM_CHANNELS` env var, comma-separated handles.
  The user's account must be a member (public channels need no join;
  private ones do).
- The rules that matter survive verbatim from the social path
  (`docs/ARCHITECTURE.md`): `captured_at` set by us at ingest, never
  parsed; a selection is gradeable only if `captured_at < kickoff_utc`;
  posts are immutable after insert; on `FloodWaitError` sleep exactly the
  returned `seconds`.

### Extraction — deterministic, no LLM

"no APIs" rules out the Anthropic extraction API. MVP extraction is a
deterministic parser (`lib/extract.js`): team names (seeded alias table —
the permanent "Man U / Man Utd / MUFC" tax), market keywords, decimal
odds. Everything unparseable is stored in the post's `raw_text` and
surfaced as **unparsed**, never silently dropped. Images are detected
(`media` flag) and reported unparsed — OCR is deliberately out of scope
(OCR at quality is an API). Confidence is assigned by rule (presence of
decimal odds + resolved fixture), not by model.

## Architecture

```
Telegram (grammJS, StringSession)
        │  new messages from tracked channels
        ▼
lib/extract.js ── deterministic parser ──► posts → selections
        │                                        (captured_at set by us)
        ▼
lib/store.js (better-sqlite3) ── sources, posts, selections,
        │                        settlements, source_scores,
        │                        notifications, ingestion_health
        ▼
lib/espn.js ── key-less scoreboard fetch: results + DraftKings odds
        │
        ▼
lib/settlement.js (REUSED) ── settle selections vs real scores
        │
        ▼
lib/scoring.js (REUSED) ── source_scores (ROI, roi_ci_low, 50-gate, CLV)
        │
        ▼
lib/notify.js (firebase-admin) ── FCM push when a rated source posts
        │
        ▼
server.js (node:http) + scan loop ── /api/health /api/status /api/sources
        │                            /api/posts /api/register-device /refresh
        ▼
Render free tier (24/7, no PC)
```

## Storage — SQLite

`better-sqlite3` (v13, Node ≥20), one file on the host's disk. The schema
is the existing Postgres schema's semantics, trimmed to this path and
collapsed into one migration (`supabase/migrations/...` and the old
`backend/db/migrations/` stay in git for the retired path):

| Table | Notes |
|---|---|
| `sources` | platform=telegram, handle, display_name, active, first_seen |
| `posts` | source_id, platform_post_id **unique**, captured_at (ours), posted_at, raw_text, media, content_hash, edited_flag |
| `selections` | post_id, source_id, fixture key (home/away/kickoff), market, pick, line, claimed_odds, verified_odds, verified_odds_source, captured_at — **immutable after insert** |
| `settlements` | selection_id, status(won/lost/void/push/ungradeable), payout_fraction, settled_at, result_payload, settlement_rule_version — reuse `lib/settlement.js` rules, quarter-lines included |
| `source_scores` | source_id, window(30d/90d/all), n_settled, roi, roi_ci_low/high, hit_rate, avg_odds, mean_clv, pct_positive_clv, longest_losing_run, computed_at |
| `notifications` | source_id, post_id, fcm_message_id, status, sent_at — audit trail of what was pushed |
| `ingestion_health` | platform(telegram/espn/fcm), status(ok/empty/error), detail, run_at — every fetch records one row, the same never-silent-fail rule |

**Ephemeral disk honesty:** Render free instances lose their filesystem on
redeploy (not on idle-sleep). Consequences, each handled:

- **Telegram session:** the refreshed `StringSession` is written to the DB
  *and* re-read from env `TELEGRAM_SESSION` at boot (DB wins if present).
  If the DB is lost on a redeploy, the stale env session still usually
  works (the auth key is the critical piece); if not, one ~2-minute
  re-auth (`docs/RUNBOOK.md`, to be written) — never automatic, and never
  silently lost: a missing/expired session makes `/api/status` report it
  as a hard error, not "no posts".
- **History:** after a DB loss, the server re-syncs the last N days of
  messages per channel from Telegram and re-fetches results from ESPN for
  the relevant date range. Settlement is deterministic from results, so
  scoring rebuilds cleanly.

## Notifications

- Server side: `firebase-admin` (v14) — the same single-dependency shape
  as `tradeapp`'s `firebase-admin`. FCM token(s) arrive via
  `POST /api/register-device` (app sends its token + install id).
- Mobile side: add `firebase_messaging` (dependency addition — flagged,
  not assumed), request permission at first launch, register the token,
  render a foreground/local notification. `google-services.json` for
  Android is injected into the APK build (new repo secret
  `GOOGLE_SERVICES_JSON`) — `build-apk.yml` gains one step.
- Trigger: a new post is ingested from a source whose latest
  `source_scores` (all-window) is `rated` (`n_settled >= 50`) with
  `roi_ci_low > 0`. Push text: source display name + one-line summary +
  tap-through deep link.
- **Cold-start reality (user's choice, documented):** with the 50-bet
  gate, the first notification comes only after a source has settled 50
  bets. For weeks the phone stays quiet while the app shows tracked
  sources climbing from `UNRATED` toward rated. That's the honest shape
  of "trusted = ROI-rated"; a manual override flag on a source is a
  one-row future change, deliberately not built now.

## Deployment — Render free tier

1. Push the repo; create a free Render account.
2. New Web Service → the repo → `backend/`, Node 20, `npm ci`, `npm start`.
3. Env vars: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`,
   `TELEGRAM_CHANNELS`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `PORT`.
4. **Sleep problem (the real gotcha):** Render free web services spin down
   after ~15 min without inbound requests, and a sleeping instance's
   `setInterval` does not poll Telegram. Fix for free: an external
   heartbeat (UptimeRobot, free) hitting `/api/health` every 5 minutes
   keeps the instance awake; grammJS reconnects on wake and catches up.
   If that proves flaky, the honest upgrade is Fly.io (~$2/mo) for a true
   always-on VM — same code, no changes.
5. First deploy boots with no session → the server runs the login flow via
   an admin-only console or the user re-runs a tiny local script
   (`scripts/make_session.js`) and pastes the string into the env var.
   Logged in the runbook.

## Mobile changes (minimal)

- `pubspec.yaml`: add `firebase_messaging` (flagged dependency add).
- `main.dart`: init Firebase, request permission, register token via
  `POST /api/register-device` on startup.
- `screens/tipsters_screen.dart` etc. already exist as shells; they point
  at the new `/api/sources` + `/api/posts` shapes instead of the retired
  `/api/strategies`.
- Everything else in `docs/DESIGN.md` (motion tokens, tabular figures,
  materials, no-demo-mode) is untouched — the app is a consumer of the
  new backend, not a rewrite.

## What is reused vs retired

**Reused as-is:** `backend/lib/scoring.js` and `backend/lib/settlement.js`
(both pure, both fully tested — 114-test suite). The §7 formula, the
bootstrap CI, `roi_ci_low` ranking, the 50-gate, CLV, and every
quarter-line settlement rule apply to `sources` unchanged.

**Retired from active service (kept in git):** the odds-market stack —
`lib/odds.js`, `lib/fixtures.js`, `lib/devig.js`, `lib/edge.js`,
`lib/supabase.js`, `lib/manualCheck.js`, the Supabase migration, and the
`/api/slips`, `/api/manual-check*`, `/api/strategies` routes. The
Aviator/virtuals audit module is untouched (it never depended on the odds
path). `deferred_social/cli_runner.py` stays as-is.

## Task order (vertical slices, one PR each)

Status as of 2026-08-14: E1–E8 all code-complete (backend: 188 tests passing
locally including a real server boot; E8 Flutter is written but uncompiled
here — no Flutter SDK — so `flutter analyze`/`test` in CI is the proof).
Everything still needing the user is in `docs/RUNBOOK.md` and `docs/STATUS.md`.

| # | Slice | Proven by |
|---|---|---|
| E1 | SQLite store + schema + `node --test` | Tests against real SQLite — **done** |
| E2 | ESPN adapter (results + odds), defensive parsing | Live calls (egress works now), captured fixtures — **done** |
| E3 | Telegram adapter (grammJS, StringSession, capture rules) | Fixture-driven tests; live session blocked on user creds — **done**, flagged |
| E4 | Extraction parser + post→selection mapping | Real channel post samples (committed as fixtures) — **done** |
| E5 | Settlement + scoring wired to sources | Real ESPN result replayed through settlement + scoring — **done** |
| E6 | FCM notify + `/api/register-device` + notification audit | Mock Firebase; live blocked on Firebase project — **done**, flagged |
| E7 | `server.js` routes + scan loop + Render deploy + runbook | Local boot; live deploy by user — **done**, flagged |
| E8 | Flutter: FCM init + repoint screens | `flutter analyze`/`test` in CI — **code written, CI is the proof** |

## Open questions for the user (defaults chosen, all reversible)

1. **Leagues to track** — which `/<league>` slugs? Default: `eng.1`
   (EPL) + one the user actually bets on. Must be live-verified per slug.
2. **DraftKings via ESPN acceptable as the reference line?** It's a soft
   book; there is no sharp line in this path by design.
3. **Text-only extraction for MVP** — image slips (the majority of real
   Telegram tips) are recorded but not parsed until OCR is added later.
