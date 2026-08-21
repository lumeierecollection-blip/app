# Status

## Current position

**Session 2026-08-21 (later) — Amendment F: backend rewritten tradeapp-style
(user request: "scrap the current backend and use the same as tradeapp").**
The E-path's credential wall is gone: no SQLite store, no MTProto Telegram
client, no session string, no `make_session.js`. Telegram channels are now
read through the public `t.me/s/<username>` preview page (the technique
tradeapp uses), state lives in memory refreshed by a self-scheduled scan
loop, device tokens / seen-post dedupe live in two small JSON files, and the
only dependency is `firebase-admin` — exactly tradeapp's footprint. The API
contract the Flutter app already speaks is unchanged (`/api/posts`,
`/api/sources`, `/api/status`, `/api/health`, `/api/register-device`,
`/refresh`), so **no mobile changes were needed**.

What this buys: a fresh deploy shows real data with **zero configuration**
— ESPN fixtures + DraftKings odds render as fixture-pulse feed entries even
with no channels configured; adding channels is just a comma-separated list
of public usernames in one env var. What was removed:
`lib/store.js`, `lib/telegram.js`, `lib/pipeline.js`, `lib/disqualifiers.js`,
`lib/notify.js`, their tests, `scripts/make_session.js`, `backend/sql/`,
and the `better-sqlite3` + `telegram` dependencies (all recoverable from git
history). What was kept unchanged because it's pure and already tested:
`lib/espn.js`, `lib/extract.js`, `lib/settlement.js`, `lib/scoring.js`.
New: `lib/sources.js` (t.me/s parser + fixture-pulse generator),
`lib/aggregator.js` (scan state machine: ingest → verify odds at insert →
settle → score), `lib/push.js` (file-backed notifier, lazy FCM), thin
`server.js`. 102 tests pass locally including a real server boot;
RUNBOOK §1–§2 rewritten for the new flow (~20 min deploy, no my.telegram.org).

**Still needed from the user:** redeploy the Render service (RUNBOOK §1 —
the env var list shrank to four keys). The post-rewrite APK is already
built and verified: run
[`32472871627`](https://github.com/lumeierecollection-blip/app/actions/runs/32472871627)
→ **`tipster-b27fae3.apk`** (21.8 MB) — proof the rewrite broke nothing on
the mobile side. Its `API_BASE_URL` comes from the repo secret, so once the
Render service is redeployed at the same URL the app points at, data flows
with no further builds.

**Session 2026-08-21 — the first real APK build succeeded.** Run
[`32466365763`](https://github.com/lumeierecollection-blip/app/actions/runs/32466365763)
built, signed, and uploaded **`tipster-040d988.apk`** (21.8 MB) — the first
compile proof of any of the B7/E8 Dart code (`flutter analyze`, `flutter
test`, and the full Gradle release build all green). What it took, all real
findings:

- **Backend aligned with tradeapp's shape (user request).** The retired
  odds-market modules were removed from the tree entirely — `lib/scan.js`,
  `lib/fixtures.js`, `lib/odds.js`, `lib/supabase.js`, `lib/manualCheck.js`,
  `lib/edge.js`, `lib/devig.js`, their five test files,
  `supabase/migrations/`, and the unused `@supabase/supabase-js`
  dependency — so `backend/` now mirrors `tradeapp/signal_aggregator/server`
  exactly: only live code. Recoverable from git history. 129 tests pass;
  server boot re-verified locally against every route.
- **A certain build-breaker found and fixed in `api_client.dart`:**
  `fetchFairPrice`/`submitManualCheck` were stranded *outside* any class
  (unresolved `_client`/`_uri`, unbalanced braces) — left over from the E8
  repoint. Removed along with the retired `FairPrice`/
  `ManualCheckResult` models and the orphaned
  `screens/manual_check_screen.dart` (nothing imported it; `/api/manual-check*`
  was retired in E7).
- **One real Dart null-safety error class caught by the first CI analyze**
  (run `32466077460`): `_Badge` in `tipsters_screen.dart` relied on type
  promotion of an instance *field*, which Dart doesn't do — fixed by
  assigning to a local first (commit `040d988`).
- **`GOOGLE_SERVICES_JSON` gate downgraded from hard-fail to warn-only**
  (user-confirmed tradeoff this session): the current APK has **push
  disabled** — it installs and runs, FCM registration just never happens.
  Adding the secret (RUNBOOK §4) and rebuilding re-enables push; the
  keystore and `API_BASE_URL` gates remain fail-loud.

**Amendment E (Prompt 9) — the no-API path: Telegram + ESPN + FCM push.
E1–E8 all code-complete; backend fully tested (188 tests passing locally,
including a real local server boot).** What's done and what still needs the
user (all documented in `docs/RUNBOOK.md`):

- **E1 — SQLite store. Done.** `backend/sql/schema.sql` + `backend/lib/store.js`
  (better-sqlite3). Tables: `sources`, `posts`, `selections` (immutable,
  `gradeable` derived from the §7 captured_at < kickoff rule, `provider_event_id`,
  `verified_odds` written at insert), `settlements` (`closing_odds` lives here,
  not on the immutable selections row), `source_scores` (now with
  `disqualified` + `disqualification_reasons`), `notifications` (queued/sent/
  failed audit trail, deduped per post), `ingestion_health`, `app_state`
  (Telegram StringSession persistence), `devices` (FCM tokens).
- **E2 — ESPN key-less adapter. Done, live-proven.** `backend/lib/espn.js`:
  `GET https://site.api.espn.com/apis/site/v2/sports/soccer/<league>/scoreboard[?dates=YYYYMMDD]`
  — fixtures, full-time results, DraftKings odds (open+close), normalized to
  decimal. Live-verified; real captures in `fixtures/espn/`. Also carries
  `dateKey`/`dateFromKey` used by the pipeline to fetch results per day.
- **E3 — Telegram poller. Done.** `backend/lib/telegram.js` (grammJS
  `telegram@2.26.22`): injectable client/sleep for tests, FloodWait sleeps the
  exact returned `seconds` then retries once, session read/write round-trips.
  `scripts/make_session.js` interactively creates the `TELEGRAM_SESSION`
  string (needs api_id/api_hash from my.telegram.org + the user's phone).
  8 tests.
- **E4 — Extraction parser. Done.** `backend/lib/extract.js`: deterministic,
  no LLM — seeded `TEAM_ALIASES`, market grammar (beat/win/draw/over/under/
  BTTS), odds token nearest the market phrase. 16 tests against synthetic
  samples in `fixtures/extract/tip_samples.json` built on the real eng.1
  fixture (Arsenal vs Coventry City, event 401879301).
- **E5 — Pipeline + source-level disqualifiers. Done.** `backend/lib/pipeline.js`
  (`ScanRunner.run`): fixtures first (so verified odds are known before the
  immutable insert) → Telegram ingest (idempotent, session/last-msg persisted)
  → settle pending against ESPN results (matched by `provider_event_id`,
  closing line to settlements) → score all windows with disqualifier overrides
  → queue + send pushes for notifiable sources. `backend/lib/disqualifiers.js`:
  post-kickoff capture rate >10%, claimed-odds inflation >8%, any selection
  posted >120 min after kickoff (the postTiming query counts **all**
  selections, since a post-after-result tip is by definition ungradeable).
  Deleted-post-rate disqualifier not computed (no deletion data) — documented.
  `lib/scoring.js`'s `disqualifiersForStrategy` no longer throws (returns `[]`;
  §7 checks now live in `lib/disqualifiers.js`). 8 tests incl. the end-to-end
  ingest → verified 1.40 → 51 settled → 50 gradeable → roi 0.40, ci_low>0 →
  notified flow.
- **E6 — FCM notify. Done, mock-tested.** `backend/lib/notify.js`
  (`firebase-admin@14.2.0` — note v14's modular API: `getApps`/`cert`/
  `getMessaging`, not the old `apps`/`messaging()`). Lazy-loads Firebase so a
  server without `FIREBASE_SERVICE_ACCOUNT_JSON` boots and runs everything
  except push. 3 tests with a fake sender. Live send blocked on the user's
  Firebase project (RUNBOOK §4).
- **E7 — server.js + deploy. Done, local-boot tested.** `backend/server.js`
  rewritten for Amendment E: `/api/health`, `/api/status` (loud Telegram
  state — session missing/expired is a hard error, never "no posts"),
  `/api/sources`, `/api/posts`, `POST /api/register-device`, `POST /refresh`,
  guarded scan loop. Old odds-market routes retired. `render.yaml` blueprint
  (Node runtime, free plan, secrets `sync: false`), `backend/Dockerfile`
  switched to node:20-slim (glibc → better-sqlite3 prebuilds) + `sql/` copy,
  `docs/RUNBOOK.md` (the full "get the app on your phone" walkthrough),
  `backend/README.md` rewritten. 1 real-boot test (spawns the server with a
  temp DB + no network env, exercises every route). Live deploy by user.
- **E8 — Flutter repoint. Code written and now compile-proven (first green
  APK build 2026-08-21, run `32466365763` — see the session note at the
  top; the notes below describe the state before that proof existed).**
  `mobile/pubspec.yaml` adds `firebase_core ^4.13.0` + `firebase_messaging
  ^16.5.0` (versions verified on pub.dev; sdk floor bumped to >=3.6.0);
  `lib/services/push.dart` (lazy `Firebase.initializeApp()` — a build without
  Firebase still boots — permission request, token → `/api/register-device`);
  `lib/main.dart` kicks off push init; `lib/services/api_client.dart` adds
  `fetchStatus`/`fetchSources`/`fetchPosts`/`registerDevice` + models;
  Tipsters tab now lists `/api/sources` (ROI, CLV, hit, bets, and a
  TRACKING/UNRATED/RATED/DISQUALIFIED badge); Slips tab now lists `/api/posts`
  (raw text + selection count); the Manual price check button is gone
  (`/api/manual-check*` retired). `.github/workflows/build-apk.yml` gains a
  loud `GOOGLE_SERVICES_JSON` secret check + `scripts/patch_android_firebase.py`
  (google-services plugin `4.4.4`, verified on maven central; both patch
  scripts proven together against a synthetic Flutter template).
- Known honest gaps, all documented in the amendment + RUNBOOK: soft-book (not
  sharp) reference line, 50-bet gate means a quiet phone for weeks, Render
  free tier sleeps without a heartbeat (UptimeRobot fix in RUNBOOK §3),
  Telegram session re-auth on redeploy (RUNBOOK §2), text-only extraction
  (no OCR).

The backend no longer runs the retired odds-market server: `backend/server.js`
was rewritten for Amendment E, and `lib/odds.js`, `lib/fixtures.js`,
`lib/devig.js`, `lib/edge.js`, `lib/supabase.js`, `lib/scan.js` +
`backend/supabase/` are retired from active service (kept in git).

**Task 0 — repo skeleton + `CLAUDE.md` + docs.** Complete.

**Amendment A (Agent Reach / social ingestion) — A1 and A2 complete, A3–A7
now on hold behind `sources.social.enabled` (default off).** Not
abandoned — Amendment B (below) demoted the whole tipster-social premise
from primary to optional, deferred until the odds-market path works end
to end. A1's research findings and A2's `deferred_social/cli_runner.py`
(moved here from `backend/ingestion/cli_runner.py` when `backend/` was
rewritten to Node.js — see the Amendment D entry below) stay in the repo
as reusable infra.

**Amendment B (odds-market path) — this is the current, primary plan.**
Real tips without socials: compute a fair price from a sharp reference
book's odds and flag selections where a soft book (or a manually-entered
price) offers a meaningfully better price. No cookies, no burner
accounts, no ToS risk. Full reasoning in `docs/ARCHITECTURE.md` §§ "Data
sources — Amendment B", "Ingestion architecture — odds-market path",
"Fair price and value detection", "Manual price check", "Scoring —
repointed to strategies".

- **B1 — evaluate and pin providers.** Complete. Originally pinned
  provisionally from secondary sources (this sandbox has no general web
  egress — confirmed via both `curl` and `WebFetch` failing on
  everything including Wikipedia), then **fully live-confirmed in B1b
  below.**
- **B1b — live provider verification. Complete, real findings, both
  providers confirmed.** A later prompt (referencing a "Prompt 5" this
  session never received — the provider pin apparently moved from The
  Odds API to **OddsPapi** in between; noting the gap rather than
  silently pretending continuity) asked for live verification via
  `scripts/verify_providers.py`, run through
  `.github/workflows/verify-providers.yml` (manual-trigger only — this
  sandbox still can't reach either host). Took 3 runs to get a clean
  result, and each failure was real, not noise:
  - **Run 1: failed correctly** — `API_FOOTBALL_KEY`/`ODDS_PROVIDER_API_KEY`
    weren't set as repo secrets yet. The script's own "fail loud, don't
    proceed partially" design caught this before making any live call.
  - **Run 2: OddsPapi blocked, and a real privacy incident.** OddsPapi's
    `/v4/sports` returned Cloudflare "error code: 1010" (a bot-signature
    block from `urllib`'s default User-Agent, not an auth failure) —
    fixed with a realistic `User-Agent`/`Accept` header. Separately and
    more seriously, API-Football's `/status` returned the account
    holder's real name and email in an `account` block, and the script
    saved/printed it unfiltered. It reached the job logs and a build
    artifact (**not** a git commit — that step only runs after a
    successful probe, and this run failed first). Neither could be
    cleaned up from this session — deleting workflow logs hit the same
    `403 Resource not accessible by integration` as triggering the
    workflow originally did. **User manually deleted the
    `provider-probe-results` artifact on run `31654579667`.** Fixed at
    the source: `_scrub_account_pii` recursively strips any `account`
    key before anything is saved, logged, or printed — a test proves it,
    and the next live run confirmed the fix in production (clean
    `account_status` output, no PII).
  - **Run 3: succeeded, real decision reached.**
    - **Pinnacle coverage on OddsPapi: confirmed live.** 10/10 probed
      Premier League fixtures returned priced Pinnacle odds — the one
      fact everything downstream depended on now has a real, positive
      answer.
    - 1xBet is in the 350-bookmaker catalog but its live odds coverage
      wasn't confirmed — that check hit a 429 rate limit first. Not
      blocking; nothing downstream depends on 1xBet the way it depends
      on Pinnacle.
    - API-Football confirmed live: Free plan, 100 req/day, matches the
      secondary-source figure. `/fixtures` for a 3-days-out date
      returned 0 results — open question for B2 (may need a competition
      filter rather than a bare date query on the Free plan).
    - Rate-limit info comes back in the 429 response body
      (`retryAfter`/`retryMs`), not headers — B2's polling needs to read
      that field for backoff.
  - Full detail and the live numbers: `docs/ARCHITECTURE.md` § "Data
    sources — Amendment B" (Odds/Fixtures subsections, both rewritten
    from "provisional" to "live-confirmed"). Raw probe responses
    committed under `fixtures/provider_probes/`.
- **B2 — fixtures + odds ingestion. Code complete and locally proven
  against real local Postgres + real captured data; live end-to-end run
  against the real APIs not yet triggered (see below).**
  - **Schema:** `fixtures`, `odds_snapshots` (append-only, confirmed by
    test), `strategies`, `manual_checks`, `ingestion_health` — 5 SQL
    migrations under `backend/db/migrations/`, applied by
    `backend/db/migrate.py` (small dependency-free runner, no
    Alembic/SQLAlchemy — tracks applied files in `schema_migrations`).
    Tested against a real local Postgres 16 instance (this sandbox has
    one installed) — every constraint (odds > 1.0, unique
    `provider_fixture_id`, `ingestion_health.status` enum) is proven by
    a test that tries to violate it, not just declared in SQL.
  - **`OddsProvider`/`FixtureProvider` adapters**
    (`backend/ingestion/odds/`), following the `SignalSource`/
    `SourceRegistry` pattern from `tradeapp` (Amendment C3):
    `OddsPapiProvider.fetch_odds()` is tested against the **real
    captured B1b payload** (`fixtures/provider_probes/oddspapi_odds_pinnacle.json`)
    — not synthetic data — and this caught two real parsing bugs before
    they could ever run live:
    1. A fixture's outcome ids ("home"/"draw"/"away") are **not
       unique** — a second "period" (likely a half, not confirmed which)
       has its own moneyline market with the same outcome ids and
       materially different real prices (1.534 vs the correct 1.165 for
       "home"). Fixed by also reading `bookmakerMarketId`'s period
       segment, confirmed only period "0" is the full match.
    2. Totals markets carry ~10 alternate lines per fixture (all
       `mainLine: false`) plus one designated main line. Without
       filtering on `mainLine`, every alternate line would have been
       ingested as if it were the primary O/U market.
    `ApiFootballFixtureProvider` is tested against **synthetic** data,
    clearly marked as such in the test file — B1b's real probe returned
    zero fixtures for its date, so there's no real non-empty payload to
    replay yet. A raw-string URL-building bug (unescaped competition
    name breaking on the space in "Premier League") was caught by this
    synthetic test anyway and fixed.
  - **Fixture identity resolution** (`fixture_matching.py`): team-name
    normalization (accent/suffix stripping) + a seeded alias table (Man
    Utd → Manchester United, Spurs → Tottenham Hotspur, etc.) + kickoff
    proximity, refusing to guess on ambiguous matches. 16 tests.
  - **Poll scheduler** (`poller.py`): discovery → 6h → 2h → 30min → 15min
    in the final 2 hours, pure functions, 12 tests. The exact widening
    tiers beyond "15 min in the final 2 hours" are this project's own
    design choice (the brief didn't specify them), documented as such in
    the module.
  - **Storage** (`storage.py`): fixture upsert, append-only snapshot
    insert, and `finalize_closing_lines` — the query that flags the
    latest pre-kickoff snapshot per (fixture, bookmaker, market,
    selection) as the closing line. Tested against real Postgres,
    including idempotency and independent handling per market.
  - **`OddsProviderRegistry`**: real thread-pool concurrency (not just a
    naming nod to `SourceRegistry.fetchAll`'s parallelism), dedupe, sort
    — tested with a timing assertion proving it's actually concurrent.
  - **`run_once.py`**: the real pipeline entrypoint — fetch fixtures,
    fetch odds, match, store, finalize closing lines, record
    `ingestion_health` for both providers on every branch (success,
    empty, error) so quota exhaustion can never look like "no data."
    Proven end-to-end against two local fake servers replaying
    realistic response shapes (2 tests) — full pipeline wiring is
    correct.
  - **Live end-to-end run: attempted, real result, partially proven.**
    `ingest-e2e.yml` ran successfully (workflow run `31656631820`) —
    all 80 tests passed against CI's real Postgres service container
    too (not just this sandbox's), migrations applied cleanly, and
    `run_once` completed without error. But the real result was
    **`Fixtures processed: 0`** — API-Football genuinely returned 0
    fixtures for "Premier League" in the next 14 days from the run's
    real date, recorded correctly as `ingestion_health` status `empty`
    (not `error` — proves that distinction actually holds in
    production, not just in tests). Because there were no fixtures to
    match, the pipeline correctly never called OddsPapi at all — so
    **OddsPapi's real odds fetch, fixture matching, and storage are
    still unproven against live data**, only against the local fake-server
    test. Two explanations are possible and not yet distinguished: a
    genuine scheduling gap (the 14-day window didn't happen to overlap
    a fixture) or a real bug in league/season resolution (many
    competitions are named "Premier League" across countries; API-
    Football's `season` parameter convention wasn't independently
    confirmed). Added `scripts/diagnose_fixtures.py` — prints every
    league matching the search (not just the one this project's
    resolver picked) and fixtures over a 90-day window with and without
    a season filter — and a new step in `ingest-e2e.yml` that runs it
    automatically. **Needs one more human-triggered run** to get the
    real answer instead of guessing.
  - Still unconfirmed for the same reason: `OddsPapiProvider.
    resolve_participant_names()` calls a `/v4/participants` endpoint
    whose exact shape isn't documented anywhere this session could
    verify — built as the best available guess, will raise clearly
    rather than silently mis-resolve team names if wrong. Won't be
    exercised until a run actually finds fixtures to match.
  - **Leading hypothesis for the 0-fixtures result, found from evidence
    already in the repo, not a new live call.** `scripts/diagnose_fixtures.py`
    confirmed league resolution itself is correct (`league_id=39`, real
    English Premier League, 2026-27 season starting 2026-08-21 — well
    inside the diagnostic's ±45-day window) and added `errors`/`results`
    field printing to the `/fixtures` response, but that fix was never
    re-run against a live trigger. Separately, `fixtures/provider_probes/
    api_football_fixtures.json` — a real response captured back in B1b —
    already shows the actual mechanism: a `/fixtures?date=...` call 3
    days out returned `"errors": {"plan": "Free plans do not have access
    to this date, try from 2026-08-12 to 2026-08-14."}` with **HTTP 200**
    and an empty `response` array. API-Football's free tier appears to
    restrict `/fixtures` to a narrow date window near real-time (the
    exact window shifts with each call, not a fixed offset), returning
    the restriction as a same-shape empty success rather than an error
    status — which would produce exactly the `ingestion_health` `empty`
    result B2's live run recorded, across every season parameter and
    window width tried, with no live re-trigger needed to explain it.
    Not fully confirmed (the `/fixtures?league=&from=&to=` query syntax
    used by `diagnose_fixtures.py` might behave slightly differently
    from the bare `?date=` query that produced this captured error), but
    strong, real evidence — worth a live re-run to confirm before B2 is
    called fully proven, deliberately not spent on that (see the note on
    scope below) while B3–B7 landed instead.

**Amendment C1 — mobile framework switched to Flutter (from Expo/React
Native), before any mobile code existed.** Docs complete as described
below; the actual Flutter code landed with B7 (see below), later in the
same overall effort.
([`lumeierecollection-blip/tradeapp`](https://github.com/lumeierecollection-blip/tradeapp),
`signal_aggregator/`) by cloning and reading it, not assumed from the
amendment's description. `CLAUDE.md`'s mobile stack table,
`docs/ARCHITECTURE.md` § "Build and delivery — the APK (Task B7)", and
`docs/DESIGN.md` §§11.1/11.3–11.5 (plus new §11.3a) are rewritten for
Flutter. Two things confirmed *not* to port from `tradeapp`:
`reddit_source.dart`'s dead anonymous Reddit endpoint (independently
corroborates the Agent Reach finding above), and `validator.dart`'s
hand-weighted heuristic scoring, which this project's de-vigged market
pricing already does better.

- **B3 — de-vig math and edge detection. Complete, tested against real
  data.** `backend/pricing/devig.py`: multiplicative de-vig for two-way
  markets, and the **power method** (not Shin's method) for three-way
  1X2 markets — chosen because it's a single monotonic root-find with no
  implicit-equation numerical-stability concerns, same bias correction
  as Shin's; reasoning documented in the module. Tested against the real
  captured Pinnacle 1X2 prices from B1b (home 1.165 / draw 7.66 / away
  15.44) — confirms the power method actually shifts probability toward
  the favorite relative to naive multiplicative de-vigging, not just
  that it runs. `backend/pricing/edge.py`: edge calculation plus every
  sanity gate from the brief (staleness, line mismatch, suspended
  market, outlier edge, immature market), each rejection collected with
  its reason, never just the first one. 24 tests.
- **B4 — manual price check. Complete, real API, tested end to end.**
  `backend/manual_check/service.py` + `api.py`: fetches the latest real
  sharp-book (Pinnacle) quote per fixture/market, runs B3's edge
  evaluation, computes a quarter-Kelly stake recommendation (capped at
  5% of bankroll — full Kelly assumes the edge estimate is exact, which
  a de-vigged market price isn't), and logs every check to
  `manual_checks` regardless of outcome, per the brief. Two FastAPI
  endpoints (`GET /manual-check/fair-price`, `POST /manual-check`) the
  Flutter app calls. 22 tests including real HTTP round-trips via
  `TestClient` against real Postgres.
- **B5 — strategy scoring with CLV. Complete, tested against a real
  50-selection sample.** `backend/scoring/`: Wilson interval, a
  decay-weighted bootstrap CI on ROI (45-day half-life, no numpy — pure
  Python `random`/`statistics`), the exact §7 ROI formula, the 50-sample
  `rated` gate, longest losing run, and CLV/`pct_positive_clv` as the
  headline metric per the B5 addendum. One documented judgment call not
  spelled out in the brief: void/push/ungradeable selections are
  excluded from both the ROI calculation and the 50-sample gate (they
  carry no P&L signal). Disqualifiers are implemented but are a
  documented no-op for `auto_odds`/`manual_check` selections, which have
  no post to disqualify — they raise `NotImplementedError` rather than
  silently doing nothing if a social-origin selection ever reaches them
  before that path is wired up. 31 tests, including a real-Postgres run
  against 50 hand-verified settled selections (ROI, CLV, hit rate all
  match hand computation).
- **B6 — settlement engine. Complete, including the ugly cases.**
  `backend/settlement/rules.py`: versioned pure functions
  (`settle_1x2`, `settle_ou`, `settle_btts`, `settle_ah`), unhandled
  markets and malformed input always resolve to `ungradeable`, never a
  guess. Asian handicap quarter-lines are handled correctly (half
  win/half push, half loss/half push) via a shared split-line helper —
  this required adding a `payout_fraction` column to `settlements`
  (migration 011) since the documented 5-status enum alone can't
  represent "half the stake won" without losing real ROI information;
  wired through to `backend/scoring` so ROI reflects it. `result_payload`'s
  shape is this project's own normalized contract, explicitly **not**
  assumed from a real API-Football response — no finished-fixture score
  payload has ever been captured in this session (the one real
  `/fixtures` probe from B1b was a plan-restriction error, see the B2
  note above). `backend/settlement/sweep.py` finds selections 150+
  minutes past kickoff with no settlement row and settles them against
  caller-supplied results — real result ingestion isn't built (no
  confirmed endpoint), so results are an explicit parameter rather than
  a fabricated fetch call. 30 tests, including every quarter-line
  combination and a real-Postgres sweep integration test.
- **B7 — Flutter app scaffold + APK build workflow. Code complete, not
  yet compiled or run — no Flutter SDK in this sandbox.** Real risk
  flagged, not hidden: every `.dart` file was hand-written without a
  compiler or `flutter analyze` to check it, the opposite of every
  other task in this project, which got local or CI proof before being
  called done. Needs the same "human triggers, read the real result"
  loop as everything else that needed live infrastructure.
  - `mobile/lib/theme/`: `motion.dart` (the three precomputed
    `SpringDescription` values from §11.3a — `withDampingRatio` is a
    factory, not const, so these are `static final`, not `static
    const`, a fix caught by re-reading the code rather than a compiler),
    `color.dart` (semantic won/lost/void, always paired with a glyph),
    `type.dart` (`FontFeature.tabularFigures()` on every numeric style,
    not just one — `tradeapp`'s gap, per the brief), `theme.dart`
    (`ColorScheme.fromSeed`, **`accentGradient` dropped** per §11.7).
  - `mobile/lib/services/api_client.dart`: talks to the real B4
    endpoints. `API_BASE_URL` (decided and recorded in
    `docs/ARCHITECTURE.md`) is injected via `--dart-define` at build
    time; an empty value shows a real error screen, never fallback
    data (Amendment B7's demo-mode-free rule).
  - `mobile/lib/app_shell.dart`: plain `IndexedStack` tabs — Slips,
    Tipsters, Audit, Health, Admin — tab label "Tipsters" kept exactly
    as `docs/ARCHITECTURE.md`'s App shell section already specified it,
    even though the underlying data is `strategy_scores`.
  - **Simplified from the full §11.8 brief, flagged honestly rather than
    silently scoped down:** no gesture-driven spring interactions yet
    (swipeable band cards, spring-expanding legs, sheet-anchored detail
    with velocity handoff) — only the three `motion.dart` springs exist,
    nothing consumes them yet. The Manual check screen uses plain
    `TextField`s and the OS numeric keyboard, not a custom large-keypad
    widget. Slips/Tipsters/Audit have no backend list endpoints yet, so
    they show real, honest empty states (no illustrations, no emoji,
    per §11.7) rather than any data.
  - `.github/workflows/build-apk.yml`: ported with the 4 documented
    fixes (fail loud on missing keystore secret — never fall back to
    debug signing; `--build-number` from the run number; artifact named
    `tipster-<short-sha>.apk`; triggers on `push: [main]` +
    `workflow_dispatch` only). Bootstraps `android/` via `flutter
    create` if absent, then `scripts/patch_android_signing.py` wires
    Flutter's own documented release-signing recipe into the generated
    Gradle file.
  - **First live run (2026-08-13, run `31692878211`): real, informative
    failure, since fixed.** Got further than expected before failing —
    Flutter SDK setup, `flutter create`, and `flutter pub get` all
    succeeded. `flutter analyze` then failed on 12
    `prefer_const_constructors` lints (info-severity, but `flutter
    analyze` still exits nonzero on them) across the empty-state
    screens — fixed by adding `const` at each flagged constructor.
    Separately, and more significantly: `flutter create` on current
    stable Flutter (3.47.0) generates **`build.gradle.kts` (Kotlin
    DSL)**, not the Groovy `build.gradle` `patch_android_signing.py`
    originally targeted — that assumption was untestable without a real
    generated file to check against, exactly the kind of gap this
    project's "prove with CI, not guesses" pattern exists to catch. The
    patch script is rewritten for Kotlin DSL's `signingConfigs {
    create("release") { ... } }` syntax, tries multiple known shapes of
    the default debug-signing line, and now prints the actual file
    content on failure so any remaining mismatch is diagnosable from one
    run instead of guessing again — 10 tests (was 6), still against a
    synthetic file, still not a real Flutter-generated one. Fixes pushed
    (commit `54c181f`); not yet re-run.
  - **Needs, before this can be called proven:** `ANDROID_KEYSTORE_BASE64`
    + `ANDROID_KEYSTORE_PASSWORD` + `ANDROID_KEY_ALIAS` +
    `ANDROID_KEY_PASSWORD` (a real release keystore was generated this
    session and handed to the user directly, not committed anywhere),
    `API_BASE_URL` (currently a placeholder, `https://api.example.invalid`
    — the Amendment E backend isn't deployed yet; see `docs/RUNBOOK.md` §1)
    and — new for Amendment E — `GOOGLE_SERVICES_JSON` (base64 of the
    Firebase `google-services.json`; the workflow now fails loudly without
    it, see `docs/RUNBOOK.md` §4), then another human trigger of
    `build-apk.yml` on this branch to see whether the Kotlin DSL fix
    actually holds.

**Amendment D (Prompt 8) — backend retired and rebuilt as plain Node.js +
Supabase + Cloud Run, replacing the FastAPI + self-run-Postgres plan
(Tasks D1–D9).** The user's brief was verified against the real
`tradeapp/signal_aggregator/server` before porting anything — cloned and
read directly (package.json's single dependency, `server.js`'s
`cache.running`/`scanChain` pattern, the exact Cloud Run deploy commands
in its README), not assumed from the brief's description alone. The old
`backend/` (Python, 179 tests, B1–B6) was removed with `git rm` — fully
recoverable from git history, not actually lost — and rebuilt fresh.

- **D1 — scaffold.** `backend/` now mirrors `tradeapp/server/`'s shape
  exactly: `server.js`, `lib/*.js` (one file per concern), `test/*.test.js`,
  `Dockerfile`, `package.json`, `README.md`. One real dependency
  (`@supabase/supabase-js`, vs. `tradeapp`'s one dependency,
  `firebase-admin`, for a different reason). `node --test` for tests, no
  framework — `package.json`'s test script deviates from `tradeapp`'s
  literal `node --test test/` to bare `node --test`, found necessary by an
  actual local run: `node --test test/` failed to resolve the directory as
  a test path on this Node version (v22.22.2), while bare `node --test`'s
  default discovery works — a real, verified fix, not copied blind.
- **D2 — ported math, same spec.** `lib/devig.js`, `edge.js`,
  `settlement.js`, `scoring.js`, `manualCheck.js`, `odds.js`, `fixtures.js`
  are direct ports of the retired Python modules (recovered from git
  history for accuracy, not rebuilt from memory). 114 tests passing
  (`npm test`), including every quarter-line settlement case and the
  OddsPapi parser replayed against the same real captured B1b payload
  (`fixtures/provider_probes/oddspapi_odds_pinnacle.json`) the Python
  tests used. **One real bug found and fixed during the port, not carried
  forward:** the Python OddsPapi parser labeled 1X2 outcomes as market
  `"h2h"`, while Python settlement's `MARKET_RULES` (built later, Task B6)
  keyed on `"moneyline"` for the same market — the two never actually
  connected in the original codebase (B2's one live run found zero
  fixtures, so nothing ever exercised settlement against a real quote).
  Fixed in the port: `lib/odds.js` now classifies 1X2 outcomes as
  `"moneyline"`, matching every other module.
- **D3 — Supabase.** `backend/supabase/migrations/20260813000001_schema.sql`:
  the same tables as the retired Postgres schema, consolidated into one
  migration (no incremental history to preserve on a fresh start),
  `payout_fraction` included from the start rather than bolted on later.
  Three Postgres functions (`finalize_closing_lines`,
  `find_pending_selections`, `load_settled_selections_for_strategy`)
  handle the queries — correlated subqueries and anti-joins — the
  Supabase JS client's query builder can't express directly. RLS
  deliberately left off: single-user app, service-role key from a trusted
  backend only, documented as a conscious choice in the migration's own
  comment. **Not live-tested against a real Supabase project** — this
  sandbox has no Supabase credentials; `lib/supabase.js` is verified to
  load correctly and fail loudly (not silently) when credentials are
  missing, but every actual query is unverified against a real database.
- **D4/D5 — scan loop + API handlers, real and running.** `server.js`
  mirrors `tradeapp/server.js`'s structure closely: `cache.running`-guarded
  `scan()`, `setInterval` on `SCAN_INTERVAL_MS`, the same `setCors`/`json`/
  `readJsonBody` helpers. **Actually started and hit locally** (not just
  syntax-checked): `/api/health` and the root endpoint respond correctly,
  and — with no Supabase/provider credentials set — `/api/status` shows
  the scan failing gracefully into `lastScanError` instead of crashing the
  process, real verified behavior matching the "never silently fail"
  standard the rest of this project holds to.
- **D6/D7 — deploy + repoint Flutter. Blocked on real credentials this
  session doesn't have** (no GCP account, no Supabase project) — cannot be
  completed without the user provisioning both and either running the
  `gcloud run deploy` command themselves or handing over credentials.
  **D7 required a real fix, not just "point at the URL" as the brief
  assumed:** the Flutter app's `api_client.dart` was built against the
  retired FastAPI backend's paths and snake_case JSON
  (`/manual-check`, `fixture_id`, `entered_odds`) — the brief's claim that
  it "already expects" the new backend's shape didn't hold. Updated to the
  real `server.js` paths (`/api/health`, `/api/manual-check`,
  `/api/manual-check/fair-price`) and camelCase fields
  (`fixtureId`, `offeredOdds`, `fairPrices`) to actually match.

## What works

- Repo skeleton exists: `CLAUDE.md`, `docs/`, `.claude/skills/`,
  `backend/`, `mobile/`, `.github/workflows/`.
- `docs/ARCHITECTURE.md`, `docs/SCORING.md` (verbatim brief §7 + the
  Amendment B5 addendum), `docs/DESIGN.md` (verbatim brief §11, with
  §11.1/§11.3–§11.5 translated to Flutter and a new §11.3a per Amendment
  C) are in place as the persistent reference for every later session.
- `.claude/skills/apple-design/SKILL.md` and
  `.claude/skills/pick-ui-library/SKILL.md` are installed and will be
  auto-discovered by Claude Code.
- Deferred social path: Agent Reach's real `doctor --json` schema and
  correct pinned-install command are verified (not guessed) and recorded
  in `docs/ARCHITECTURE.md`. `deferred_social/cli_runner.py` (11
  passing tests) is built and ready for whenever A3+ resumes.
- **Odds-market path (B2), locally proven** (`cd backend &&
  DATABASE_URL=postgresql://... python3 -m pytest`): schema + migrations,
  both provider adapters (one tested against real captured data), fixture
  matching, poll scheduler, storage layer including closing-line
  finalization, provider registry, and the full pipeline entrypoint
  proven against realistic fake servers. Real Postgres 16 is installed in
  this sandbox and was used for every DB-touching test — not mocked, not
  SQLite.
- **B3–B6 (de-vig, edge detection, manual price check, strategy scoring
  with CLV, settlement), all locally proven against real Postgres** — see
  the task table above for what each proves. **179 backend tests passing
  in total** (`cd backend && DATABASE_URL=postgresql://... python3 -m
  pytest`), all real assertions against real math and real database state,
  no mocked DB layer anywhere in the suite.
- **B7 (Flutter app + APK build workflow), code complete, not yet
  compiled** — see the task table above. `scripts/patch_android_signing.py`
  (the Gradle signing patch) has 6 passing tests against a synthetic
  build.gradle (`python3 -m pytest scripts/tests/`).

## What's stubbed

- The poll *scheduler* logic (`poller.py`) exists and is tested, but
  nothing calls it on an actual recurring schedule yet — `run_once.py`
  is a single unconditional pass, proving the pipeline works, not a
  cron loop. Wiring the schedule in is part of turning this into a real
  recurring GitHub Actions cron job, not yet done.
- Real match-result ingestion for B6's settlement sweep — no confirmed
  API-Football endpoint/shape for finished-fixture scores exists (see
  the B6 entry above); `settle_selections_with_results` takes results as
  an explicit parameter and is ready to consume real ones the moment
  that ingestion is built.
- The slip builder (brief §8) — `slips` table exists (migration 009) but
  nothing writes to it yet. Needs `strategy_scores` populated with real
  rated (`n_settled >= 50`) strategies first, which needs real settled
  volume, which needs the live odds-ingestion question above resolved.
- The audit module (Aviator/virtuals) — `audit_calls` table exists
  (migration 010), no ingestion or scoring built.
- Every B7 gesture-driven interaction from `docs/DESIGN.md` §11.8 beyond
  the static screens: swipeable band cards, spring-expanding legs,
  sheet-anchored tipster/strategy detail with velocity handoff, the
  review queue. Only the three `motion.dart` springs exist; nothing
  consumes them yet.
- Fixture/market browsing on the Manual check screen — fixture ID,
  market, and pick are typed in directly; no fixture-list backend
  endpoint exists to build a picker against yet.

## What's blocked

- **B2's live end-to-end proof needs a human to trigger
  `.github/workflows/ingest-e2e.yml`** again from the Actions tab (the
  diagnostic script was updated to print the API's `errors`/`results`
  fields, which the last run didn't capture) — this session's GitHub API
  access can't dispatch workflows (confirmed: same 403 that blocked
  triggering `verify-providers.yml` earlier). Both required secrets are
  already in place and confirmed working. See the B2 entry above for the
  leading hypothesis (a free-tier date-range restriction) found from
  evidence already in the repo, not yet confirmed by a live re-run.
- **B7's APK build needs, before it can run at all:** a real Android
  release keystore (`ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD`
  + `ANDROID_KEY_ALIAS` + `ANDROID_KEY_PASSWORD` as repo secrets — never
  commit the keystore itself) and a real deployed backend host for
  `API_BASE_URL` (nothing has been deployed anywhere persistent yet —
  every proof so far ran against CI's throwaway Postgres or this
  sandbox's local one), then a human trigger of `build-apk.yml`.
- **Before B2's ingestion can run on an actual recurring schedule** (as
  opposed to the one-shot proof above), and before the backend can serve
  the mobile app for real: a persistent Postgres instance (Supabase or
  Neon) and its connection string, and a real host to deploy
  `backend/api/main.py` to (uvicorn behind something, TBD).
- **Not currently blocking anything, kept for whenever the social path
  resumes:**
  - A burner Twitter/X account + Cookie-Editor-exported
    `TWITTER_AUTH_TOKEN`/`TWITTER_CT0` (Amendment A4).
  - A Reddit account + manually-authored `rdt-cli` cookie (Amendment A5).
  - A residential proxy budget, e.g. Webshare ~$1/month (A4/A5).
  - Telegram `api_id`/`api_hash` and a persistent-volume host decision
    (original Task 1's Telegram ingest, now optional).
- **Will block later tasks, not yet needed:**
  - Anthropic API key, if/when the social path's extraction stage
    resumes (deferred Task 2).

## How to download and install the APK

Working since 2026-08-21. Open
[run `32466365763`](https://github.com/lumeierecollection-blip/app/actions/runs/32466365763)
(or any newer green **Build APK** run under the Actions tab), download the
`tipster-<short-sha>.apk` artifact from the run's Artifacts section, copy it
to the phone, enable "install from unknown sources" once, and install.
Verify the installed build's short SHA matches the commit you expected.

Two caveats on the current artifact: it was built **without**
`GOOGLE_SERVICES_JSON`, so push notifications are inactive until that secret
is added and a new APK is built (RUNBOOK §4); and `API_BASE_URL` points at
whatever is set as that repo secret — the backend must actually be deployed
(RUNBOOK §1–2) for the tabs to show live data.

## Notes for the next session

- Read `CLAUDE.md` first, then `docs/ARCHITECTURE.md`, `docs/SCORING.md`,
  `docs/DESIGN.md`, then this file, before writing any code.
- **All of B3–B7 landed in one continuous push (this session), at the
  user's explicit direction to stop gating each step on a live-trigger
  round trip and get straight to a working app — a deliberate departure
  from Prompt 7's original step-by-step sequencing rule.** Everything
  backend-side (B3–B6) is still real and proven against real local
  Postgres, same standard as B1/B2; only B7 (Flutter) couldn't be proven
  the same way, for a reason outside this session's control (no Flutter
  SDK in this sandbox), and that gap is flagged everywhere above rather
  than glossed over.
- **Immediate next steps, in order:**
  1. Trigger `ingest-e2e.yml` once more to get the real `errors` field
     from API-Football and confirm or correct the free-tier date-range
     hypothesis in the B2 entry above.
  2. Generate a real Android release keystore, add all four
     `ANDROID_KEYSTORE_*` secrets, and trigger `build-apk.yml` — this is
     the first real compile of any of the B7 Dart code, and likely won't
     succeed on the first try (the Gradle signing patch in particular is
     unverified against a real generated `build.gradle`). Fix forward
     from whatever the real CI error says, the same way B1b's live
     verification took three real, informative failures before it
     passed.
  3. Provision a persistent Postgres (Supabase or Neon) and deploy
     `backend/api/main.py` somewhere reachable, so `API_BASE_URL` points
     at something real rather than blocking the APK build entirely.
  4. Once fixtures are actually flowing (step 1) and settling, revisit
     the slip builder (brief §8) — `strategy_scores` needs real rated
     strategies first, which needs real settled volume.
- Do not resume Amendment A (A3–A7, the social path) until B1–B7 are
  working end to end, per Amendment B's own priority. The code and
  research there don't rot; there's no urgency to touch them.
- Dependencies added beyond `CLAUDE.md`'s original stack table, all
  flagged transparently rather than blocking on permission (same pattern
  as `psycopg` in B2): `fastapi`, `uvicorn`, `pydantic` (all three
  already named in the stack table's API row, just not yet added to
  `requirements.txt`), `httpx` (dev-only, for FastAPI's `TestClient`),
  and on the Flutter side `http` (no HTTP client was named in the Mobile
  stack table) plus `shared_preferences` (explicitly named already, for
  the `tradeapp`-derived storage pattern).
