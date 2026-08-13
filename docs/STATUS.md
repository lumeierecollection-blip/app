# Status

## Current position

**Task 0 — repo skeleton + `CLAUDE.md` + docs.** Complete.

**Amendment A (Agent Reach / social ingestion) — A1 and A2 complete, A3–A7
now on hold behind `sources.social.enabled` (default off).** Not
abandoned — Amendment B (below) demoted the whole tipster-social premise
from primary to optional, deferred until the odds-market path works end
to end. A1's research findings and A2's `backend/ingestion/cli_runner.py`
stay in the repo as reusable infra.

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

**Amendment C1 — mobile framework switched to Flutter (from Expo/React
Native), before any mobile code existed.** Complete, this PR: docs only,
verified against the real reference repo
([`lumeierecollection-blip/tradeapp`](https://github.com/lumeierecollection-blip/tradeapp),
`signal_aggregator/`) by cloning and reading it, not assumed from the
amendment's description. `CLAUDE.md`'s mobile stack table,
`docs/ARCHITECTURE.md` § "Build and delivery — the APK (Task B7)", and
`docs/DESIGN.md` §§11.1/11.3–11.5 (plus new §11.3a) are rewritten for
Flutter. This doesn't move Task B7 earlier — B2 is still next in the
task order — but the plan for B7 is now fully specified: port
`tradeapp`'s working `build-apk.yml` (fixing 4 confirmed bugs: silent
debug-signing fallback, missing `--build-number`, fixed artifact name,
overly broad triggers) and several of its patterns
(`SignalSource`/`SourceRegistry` → `OddsProvider`/`ProviderRegistry`,
`PaperTrader` → default-on paper-betting mode, `FactorScore.plain` →
one-sentence rationale, `theme.dart` structure minus its gradient). Two
things confirmed *not* to port: `reddit_source.dart`'s dead anonymous
Reddit endpoint (independently corroborates the Agent Reach finding
above — worth checking if that source has been silently dead), and
`validator.dart`'s hand-weighted heuristic scoring, which this project's
de-vigged market pricing already does better.

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
  in `docs/ARCHITECTURE.md`. `backend/ingestion/cli_runner.py` (11
  passing tests) is built and ready for whenever A3+ resumes.
- **Odds-market path (B2), locally proven, 80 tests passing** (`cd
  backend && DATABASE_URL=postgresql://... python3 -m pytest`): schema +
  migrations, both provider adapters (one tested against real captured
  data), fixture matching, poll scheduler, storage layer including
  closing-line finalization, provider registry, and the full pipeline
  entrypoint proven against realistic fake servers. Real Postgres 16 is
  installed in this sandbox and was used for every DB-touching test —
  not mocked, not SQLite.

## What's stubbed

- `mobile/` is still an empty directory — no code yet (Task B7).
- B3 (de-vig/edge detection), B4 (manual price check), B5/B6
  (scoring/settlement) — not started. B2's schema (`strategies`,
  `manual_checks`) exists ahead of them per the amendment's own grouping
  but isn't populated or read yet.
- The poll *scheduler* logic (`poller.py`) exists and is tested, but
  nothing calls it on an actual recurring schedule yet — `run_once.py`
  is a single unconditional pass, proving the pipeline works, not a
  cron loop. Wiring the schedule in is part of turning this into a real
  recurring GitHub Actions cron job, not yet done.

## What's blocked

- **B2's live end-to-end proof needs a human to trigger
  `.github/workflows/ingest-e2e.yml`** from the Actions tab — this
  session's GitHub API access can't dispatch workflows (confirmed: same
  403 that blocked triggering `verify-providers.yml` earlier). Both
  required secrets (`API_FOOTBALL_KEY`, `ODDS_PROVIDER_API_KEY`) are
  already in place and confirmed working. No persistent Postgres
  instance is needed for this proof — the workflow spins up its own
  throwaway Postgres 16 service container in CI.
- **Before B2's ingestion can run on an actual recurring schedule** (as
  opposed to the one-shot proof above): a persistent Postgres instance
  (Supabase or Neon) and its connection string, for real production
  storage across runs. Not needed to *prove* B2 works, only to *operate*
  it continuously.
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
  - `ANDROID_KEYSTORE_BASE64` + password/alias secrets for signed APK
    builds (Task B7, Flutter now — see Amendment C) — generate and store
    as GitHub secrets when that task starts; never commit the keystore.
  - The real API-URL secret for the mobile build once the API has a real
    host (naming convention TBD at B7 — Flutter/dart-define, not
    `EXPO_PUBLIC_*`).

## How to download and install the APK

Not applicable yet — the build workflow doesn't exist until Task B7.
This section gets filled in with exact steps (download from the Actions
run artifact, enable "install from unknown sources" once, install,
verify the installed build matches the expected commit) when that task
lands.

## Notes for the next session

- Read `CLAUDE.md` first, then `docs/ARCHITECTURE.md`, `docs/SCORING.md`,
  `docs/DESIGN.md`, then this file, before writing any code.
- **B2's code is done; its live proof is pending a human trigger.** Once
  `ingest-e2e.yml` has been run, read its output (fixtures/odds_snapshots
  actually written, ingestion_health rows) and update this file with the
  real result — especially whether `/v4/participants` resolved names
  correctly (see "What works" above) and whether API-Football's real
  fixture shape matches the synthetic test's assumptions. **B3 (de-vig
  math) is next after that** — `fixtures/provider_probes/` already has
  real Pinnacle odds payloads to test against.
- Do not resume Amendment A (A3–A7, the social path) until B1–B7 are
  working end to end, per Amendment B's own priority. The code and
  research there don't rot; there's no urgency to touch them.
- No dependencies have been added yet beyond what's implied by the stack
  table in `CLAUDE.md` — anything else needs to be asked about first.
  Agent Reach is the one addition from Amendment A; it's pinned to a SHA
  in `docs/ARCHITECTURE.md`, not tracked on `main`, and unused while the
  social path is disabled.
- When B7 starts: read `tradeapp`'s files directly before porting
  anything from them (`docs/ARCHITECTURE.md` § "Patterns to port from
  `tradeapp`" names the exact files) — don't rebuild from this repo's
  summary of them, the summary can drift from the source.
