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
- **B2–B7** — not started. Next up is B2: fixtures + odds ingestion,
  `odds_snapshots` (append-only), closing-line capture. Unblocked now —
  both provider pins are live-confirmed, not assumed.

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

## What's stubbed

- `mobile/` is still an empty directory — no code yet (Task B7).
- `backend/` has only `ingestion/cli_runner.py` so far (Amendment A2,
  deferred-path infra). No models, no migrations, no API, no odds-market
  ingestion code yet — that's B2.

## What's blocked

- **B2 (fixtures + odds ingestion) needs, before or during that
  session:**
  - A Postgres instance (Supabase or Neon) and its connection string —
    same requirement the original Task 1 had, just for the odds-market
    schema now (`fixtures`, `odds_snapshots`, `strategies`,
    `strategy_scores`, `manual_checks`, shared `selections`). This is
    the only remaining blocker — both API keys are already in place as
    repo secrets (`API_FOOTBALL_KEY`, `ODDS_PROVIDER_API_KEY`) and
    confirmed working live as of B1b.
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
- **B2 is next.** Design the Postgres schema additions from
  `docs/ARCHITECTURE.md` § "Data model", build the fixtures/odds polling
  job (widening intervals → 15-minute intervals in the final 2 hours),
  and get a real API key in hand early — both to build against real
  responses and to resolve the Pinnacle/tier question B1 left open.
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
