# Architecture

This is a working summary of the system's pipeline, data model, and
adapters. `docs/SCORING.md` is the verbatim, authoritative source for
reliability scoring — this file summarizes the stages around it. When the
two disagree, `docs/SCORING.md` wins for anything scoring-related.

## What the system does

1. Ingests posts from betting-tip accounts on Telegram, Reddit, X, and
   (best effort) Facebook.
2. Parses each post into structured **selections** — match, market, pick,
   odds, bookmaker, kickoff.
3. Snapshots every selection at capture time so the source can't
   retroactively edit or delete it.
4. Settles each selection against real results after the fixture
   completes.
5. Maintains a rolling ROI-based reliability score per account, per
   market type, with confidence intervals and a minimum-sample gate (see
   `docs/SCORING.md`).
6. Assembles surviving high-confidence selections into daily accumulator
   slips across five odds bands.
7. Runs an audit-only track for Aviator and virtual matches.
8. Serves all of it to a native Android app.

## Data sources

Each source is handled by its own adapter behind a common `SourceAdapter`
interface — there is deliberately no single generic scraper. This section
was amended to replace the original PRAW/paid-X-API plan after live
research into [Agent Reach](https://github.com/Panniantong/agent-reach)
showed the situation on Reddit and X had changed. Findings below are
verified against the actual repo and a real install, not assumed from
its README — see "Agent Reach — verified findings" below for how each
claim was checked.

### Telegram — primary source, built first, unaffected by this amendment
Most real tipster volume is here, and it's the only platform with a
clean, permitted, high-throughput read path.

- **Telethon** (MTProto user client), or the Bot API where a channel
  allows bots.
- Needs `api_id` / `api_hash` from my.telegram.org and a persistent
  session file on a mounted volume. Losing that file means
  re-authenticating by SMS.
- Event-handler subscription gives real-time receipt, which makes
  post-time snapshotting trivial.
- On `FloodWaitError`, sleep exactly the `seconds` value it carries.
  Never retry blind.
- Agent Reach does not cover Telegram. This adapter is built with
  Telethon directly, exactly as originally planned.

### X / Twitter — `twitter-cli` via Agent Reach, no paid API needed
The original plan required Basic-tier paid API access or shipping
without X. Agent Reach's `twitter-cli` backend removes that requirement:
it authenticates with exported browser cookies and runs headless, so it
works from a GitHub Actions runner with no API fee.

- **This is cookie-based, ToS-adjacent access on a burner account, not
  an official integration.** Real risk: the account can be banned, and a
  leaked cookie pair is full account takeover (no password needed). See
  Credential lifecycle below.
- Auth: export `TWITTER_AUTH_TOKEN` and `TWITTER_CT0` from x.com via the
  Cookie-Editor "Header String" method, save with
  `agent-reach configure twitter-cookies --stdin` (verified flag —
  `--stdin` avoids putting the cookie value in process arguments), then
  inject explicitly into each child process's environment at call time.
  `doctor` only confirms the credentials were saved; it never runs
  `twitter status`, so it cannot tell us whether they still work — our
  own liveness probe has to do that (see A3/A4 below).
- **Prefer `twitter user-posts @handle -n 20` over `twitter search`** for
  polling tracked tipster accounts. The repo's own reference
  (`references/social.md`) flags `search` as unstable — X changes its
  GraphQL endpoint often enough that it can 404 — while `feed`,
  `tweet`, `user-posts`, and `user` are the "stable commands." Since our
  use case is "poll a known list of tipster handles," not open-ended
  search, we can build entirely on the stable path.
- IP risk: the repo warns against frequent calls from a VPS/datacenter
  IP, especially `followers`/`following` (we don't need those). A
  residential proxy (Webshare, ~$1/month, referenced by the repo) reduces
  ban risk; budget for it.
- Poll tracked handles. Record `posted_at` from the tool and
  `captured_at` ourselves. A consistently large gap between them means
  the polling interval is too slow to catch pre-kickoff tips, which
  silently corrupts the §7 gradeability rule — track this as a
  data-quality signal, not just a debugging curiosity.

### Reddit — no zero-config path exists; confirmed independently
The original plan (PRAW, self-service script app) is dead for anyone who
doesn't already hold Reddit API credentials, and this was checked two
ways, not just taken from the Agent Reach README:

1. `agent_reach/channels/reddit.py`'s own docstring says, live-verified
   2026-06: anonymous `.json` endpoints are 403-blocked, and Reddit
   closed self-service API registration in November 2025 (manual
   approval only; individual scripts are rarely granted).
2. An independent web search (2026-08) corroborates this: Reddit
   replaced self-service OAuth registration with a "Responsible Builder
   Policy" in late 2025 — any new token needs prior approval through a
   ticket form, and personal/script-app use cases are not the kind that
   gets approved.

**Conclusion: do not build the Reddit adapter on PRAW.** Use Agent
Reach's Reddit channel instead, which has two backends:

- **OpenCLI** — reuses an already-logged-in desktop Chrome session.
  Confirmed **not viable for us**: it requires a live desktop browser,
  which a GitHub Actions runner or headless worker doesn't have. This is
  the repo's own recommended *first* backend, but only for desktop users.
- **rdt-cli** — the only backend that actually works headless. Install
  from GitHub, pinned, **not PyPI** (PyPI is behind):
  `pipx install 'git+https://github.com/public-clis/rdt-cli.git@5e4fb3720d5c174e976cd425ccc3b879d52cac66'`
  (this exact pin is read directly from `_RDT_GIT_SOURCE` in
  `agent_reach/channels/reddit.py`, confirmed matching `doctor`'s own
  install hint). Auth is a manually-written cookie file
  (`~/.config/rdt-cli/credential.json`, containing the `reddit_session`
  cookie value from Cookie-Editor) — there's no automated login path on
  a server. Agent Reach tracks this credential's age and treats it as
  stale after 7 days.
- **Known risk on top of the ToS issue: `rdt-cli` itself is
  unmaintained** — the repo's own docs say upstream stopped updating it
  in March 2026. This is a legacy/fallback tool by the maintainer's own
  description, not a first-class one. Treat it as more fragile than
  `twitter-cli` and expect to revisit this adapter sooner.
- Either way, capture the `edited` state once available. The main
  brief's rule holds: a tip edited after kickoff is disqualified.
- Expect to need the same residential proxy as X — the repo explicitly
  calls out server IPs getting blocked on Reddit.

### Facebook / Instagram — still deprioritized, confirmed correctly so
Agent Reach's own docs are explicit that Facebook and Instagram route
through OpenCLI only, reusing a live desktop Chrome session logged into
facebook.com/instagram.com, and **do not recommend this for servers or
headless environments.** Read directly:
`agent_reach/channels/facebook.py` has exactly one backend, `OpenCLI`,
with no alternative. This confirms rather than changes the main brief's
call to deprioritize Facebook.

- Adapter interface defined, left unimplemented. Manual-paste fallback
  in the admin screen instead. Do not spend session time on bot
  detection or on making OpenCLI work headless — the repo's own authors
  say not to.
- If a specific Facebook tipster later proves worth the effort, revisit
  it as a separate desktop-attached collector, not part of the cloud
  pipeline.

### Agent Reach — verified findings (2026-08-12)

Agent Reach is an installer/router/health-checker, not a library: the
`AgentReach` Python class only does health checks. The actual reading is
done by separate CLIs it installs (`twitter`, `rdt`, `opencli`, `yt-dlp`,
`gh`, `mcporter`). Adapters shell out to those and parse stdout — see
`cli_runner.py` in A2 below.

- **Pinned commit:** `93ae1d18c37b707dec053c7c4f9d91cd8ef8943d` (`main`
  as of 2026-08-12). Do not track `main`; bump this deliberately when a
  session verifies the new commit against the checks below.
- **Correct install — this matters, it was wrong in the version briefed
  to this session:** `pip install agent-reach` installs a **different,
  unrelated PyPI package** — `agent-reach` 0.1.0 by Jean Galea
  (`github.com/jgalea/agent-reach`), a name collision with an entirely
  different CLI (`{list,install,remove,doctor,get,skill,cache}` instead
  of the expected `{setup,install,configure,doctor,uninstall,skill,...}`).
  This was caught by actually installing it and diffing the `--help`
  output against the repo's docs, not assumed. **Use the pinned Git
  install instead**, confirmed working:
  ```bash
  pip install "git+https://github.com/Panniantong/agent-reach.git@93ae1d18c37b707dec053c7c4f9d91cd8ef8943d"
  ```
  (`pipx` in place of `pip` for an isolated install, same syntax.)
- **`agent-reach doctor --json` schema — confirmed by running it, not
  guessed.** Top-level object keyed by platform slug
  (`"twitter"`, `"reddit"`, `"facebook"`, …), each value:
  ```json
  {
    "status": "ok" | "warn" | "off" | "error",
    "name": "<display name>",
    "message": "<human-readable status/instructions>",
    "tier": 0 | 1 | 2,
    "backends": ["<backend name>", ...],
    "active_backend": "<backend name>" | null
  }
  ```
  Observed status semantics, confirmed against a real run with nothing
  configured:
  - `off` — no backend installed at all for that platform.
  - `warn` — a backend is installed, but not live-verified. **Important:
    for login-backed platforms (twitter, reddit, facebook, …),
    `active_backend` is `null` even once credentials are correctly
    configured** — `doctor` deliberately never runs the upstream
    liveness check (`twitter status`, etc.) because that check falls
    back to reading a live browser session on failure, which would
    violate the Cookie-Editor-only policy. **A null `active_backend` on
    these platforms is normal, not a failure signal** — this is why A3's
    preflight gate can't just check `active_backend is not null`; see A4.
  - `ok` — verified working (observed for `rss`/`feedparser` and
    `yt-dlp` once its JS runtime was configured).
  - `error` — installed but broken.
- **`agent-reach configure twitter-cookies --stdin` is real** — confirmed
  via `agent-reach configure --help`. Non-interactive credential storage
  for CI is possible; never pass the cookie value as a positional
  argument (`--stdin` exists specifically to avoid that).

### Odds and results — the settlement backbone
Without reliable results there is no scoring and the product is
worthless.

- **Fixtures + results:** API-Football (api-sports.io) or SportMonks.
  Need kickoffs, final scores, and granularity for 1X2, O/U, BTTS, AH,
  correct score, cards, corners.
- **Odds:** The Odds API or equivalent, to verify the odds a tipster
  claimed were actually available. Claimed-odds inflation is rampant —
  if they say 2.10 and the market was 1.72, score them at 1.72.
- Cache aggressively. These are metered.

## Ingestion architecture — where Agent Reach sits

Agent Reach and its upstream CLIs live **only in the ingestion layer**.
Nothing downstream of `posts` knows they exist.

```
                    ┌─ Telegram ──── Telethon (persistent worker)
                    │
ingestion adapters ─┼─ X ─────────── twitter-cli   ┐
                    │                              ├─ installed & health-checked
                    ├─ Reddit ─────── rdt-cli      ┘   by Agent Reach
                    │
                    └─ Facebook ───── manual paste (unimplemented adapter)
                                │
                                ▼
                    normalize → posts table (captured_at set by us)
                                │
                                ▼
                    extraction → selections → settlement → scoring → slips
```

Every adapter — Telegram included — implements the same `SourceAdapter`
interface and emits the same normalized `RawPost` shape regardless of
which CLI produced it. If Agent Reach is later dropped or a backend
changes, only the adapter layer moves.

### Subprocess contract

The upstream CLIs (`twitter`, `rdt`, `opencli`) are third-party binaries
producing text, not a library with a stable interface. Every adapter goes
through one shared runner, `backend/ingestion/cli_runner.py`, which must:

- **Pass credentials via the child process environment only** — never in
  argv, which is visible in process listings. Twitter needs
  `TWITTER_AUTH_TOKEN` / `TWITTER_CT0` explicitly in the child env; the
  parent process's own env is never mutated.
- **Never log credential values.** Redact them from any captured stderr
  before it reaches logs, with a test proving it.
- **Hard timeout on every call** (start at 120s) — these tools hang.
- **Capture stdout and stderr separately.** Never parse stderr as data.
- **Prefer structured output** — `-f yaml` / `--json` where offered.
- **Treat exit code 0 with empty output as a failure**, not an empty
  result set. Silent cookie expiry looks exactly like "no new posts,"
  and that failure mode will quietly poison scoring data if it's not
  caught here.
- **Retry with backoff** following the retry chains in
  `agent_reach/skill/references/social.md` — e.g. Twitter search's
  documented chain is: retry once → `pipx upgrade twitter-cli` and retry
  → fall back to stable commands (`feed`, `user-posts`). Never improvise
  a different chain.
- **Write only to `/tmp/` and `~/.agent-reach/`**, per the repo's own
  workspace rule.

Parser tests run against real captured payloads committed to
`fixtures/`, captured once by hand and never regenerated in CI.

### Doctor as a hard preflight gate

Every ingestion run calls `agent-reach doctor --json` first (schema
confirmed above) and parses it before doing anything else.

- A platform whose `status` is `off` or `error` is **skipped for that
  run and recorded as a skip** — never treated as "no posts found."
- A platform whose `status` is `warn` (the normal state for
  correctly-configured login-backed platforms — see the `active_backend`
  note above) proceeds, but only after our **own liveness probe**: one
  cheap read against a known-good target, requiring non-empty content,
  since `doctor` explicitly does not verify credentials still work.
- Persist doctor output per run in an `ingestion_health` table:
  timestamp, platform, `status`, `active_backend`, message.
- **Surface degradation in the app.** If X has been unhealthy for 24
  hours, the Tipsters screen must say so — otherwise a source's apparent
  silence is indistinguishable from cookie expiry, and its score drifts
  on stale data while looking fine.

### Credential lifecycle

Cookie-based access degrades silently, so expiry is treated as an
expected event, not an incident:

- All credentials in GitHub secrets, nothing in the repo, with a
  secret-scanning pre-commit hook.
- `docs/RUNBOOK.md` (Task A6) documents re-exporting cookies with
  Cookie-Editor and verifying with `doctor`, written for a phone.
- When `doctor` reports a platform unhealthy two runs in a row, the
  Actions workflow opens a GitHub issue automatically.
- Track credential age in `ingestion_health` and warn ahead of the
  observed typical expiry window once there's data to establish one.

### Accepted risks

- **This is cookie-based access, against X's and Reddit's ToS.** Use
  burner accounts, not real ones — the account can be banned.
- **A leaked `TWITTER_AUTH_TOKEN` + `TWITTER_CT0` pair is full account
  takeover**, no password needed. GitHub secrets only, never logged,
  never in argv.
- A residential proxy (Webshare, ~$1/month) is budgeted for, since the
  repo documents server IPs getting blocked on both Reddit and X.

### Scheduling

- **Telegram worker:** continuous, on the persistent host — unchanged.
- **X and Reddit polls:** GitHub Actions cron, every 10 minutes during
  match hours, hourly overnight. A tip captured after kickoff is
  worthless under §7's gradeability rule, so the poll interval has to
  outrun pre-match posting, not just eventually catch up.
- Agent Reach and the upstream CLIs install in a cached workflow step —
  cold-installing on every run burns Actions minutes for no reason.
- `doctor` runs first, in the same job, and the job fails loudly on a
  total outage.

### Task order for this amendment

| # | Task | Status |
|---|---|---|
| A1 | Read the repo, write findings here, pin the SHA | Done, this PR |
| A2 | `cli_runner.py` + credential redaction + timeout handling, with tests | Done, this PR |
| A3 | Doctor preflight + `ingestion_health` table + skip-vs-warn distinction | Next |
| A4 | X adapter via `twitter-cli`, with liveness probe | Blocked — needs a burner X account + Cookie-Editor cookies |
| A5 | Reddit: `rdt-cli` adapter (official-API path confirmed unavailable, see above) | Blocked — needs a burner Reddit account + cookies |
| A6 | `docs/RUNBOOK.md` + automatic issue-on-failure | |
| A7 | Health surfacing in the mobile app | |

### A2 — `backend/ingestion/cli_runner.py`

Implemented as the one shared entry point every adapter uses to shell out
to an upstream CLI:

- `run(argv, env_overrides=..., timeout=..., allow_empty_output=...)` —
  one invocation. Credentials are merged into the child's environment
  only (`{**os.environ, **env_overrides}`); the current process's own
  `os.environ` is never mutated. stderr is redacted against every
  credential value before it can reach a log line or an exception
  message. Raises `CliTimeoutError` on timeout, `CliCommandError` on a
  non-zero exit, and `CliEmptyOutputError` on exit 0 with empty stdout
  (the silent-expiry failure mode) unless the caller opts out for a
  command it knows can legitimately return nothing.
- A defensive check, `_assert_no_secrets_in_argv`, rejects the call before
  spawning anything if a credential value appears in `argv` — this caught
  a real bug in the module's own first test draft (a secret value had
  been embedded directly in a test script's source instead of read back
  from the child's env at runtime), which is exactly the mistake this
  check exists to catch.
- `run_with_retry(...)` retries the *same* command with exponential
  backoff — this is only the "retry once" opening step common to every
  documented retry chain in `references/social.md`. A chain that falls
  back to a *different* command (Twitter search's documented chain:
  retry → `pipx upgrade twitter-cli` && retry → fall back to
  `feed`/`user-posts`) is adapter-specific and composed from multiple
  `run()` calls in Task A4/A5, not encoded generically here.
- Tests (`backend/ingestion/tests/test_cli_runner.py`) spawn real child
  processes (`python3 -c "..."`) rather than mocking `subprocess.run`, so
  the timeout, env-injection, and redaction behavior is proven against an
  actual OS process. Run with `cd backend && python3 -m pytest`.

Facebook stays unimplemented. Telegram is unaffected by this amendment.

## Data model (Postgres)

```
sources          id, platform, handle, display_name, first_seen, active,
                 followers_at_capture, notes

posts            id, source_id, platform_post_id, captured_at, posted_at,
                 raw_text, raw_json, media_urls, edited_flag, edited_at,
                 content_hash, deleted_detected_at

selections       id, post_id, sport, competition, fixture_id, home, away,
                 kickoff_utc, market, pick, line, claimed_odds,
                 verified_odds, verified_odds_source, bookmaker,
                 confidence_extraction, extraction_model, created_at

settlements      selection_id, status(won|lost|void|push|ungradeable),
                 settled_at, result_payload, settlement_rule_version

source_scores    source_id, market_class, window(30d|90d|all),
                 n_settled, roi, roi_ci_low, roi_ci_high, hit_rate,
                 avg_odds, longest_losing_run, computed_at

slips            id, band(A|B|C|D|E), target_min_odds, target_max_odds,
                 combined_odds, legs_json, built_at, status, settled_at

audit_calls      id, source_id, game(aviator|virtual_football|...),
                 claimed_target, claimed_outcome, verifiable(bool),
                 posted_at, captured_at, notes
```

**Non-negotiable constraints:**

- `posts.captured_at` is set by us at ingest. Never parsed from the
  platform.
- `content_hash` hashes the tip's semantic content at capture. Later
  divergence flags the post as edited and disqualifies it.
- A selection is gradeable only if `captured_at < kickoff_utc`. Anything
  captured after kickoff is stored but permanently excluded from
  scoring. **This single rule is what stops fake tipsters gaming the
  system.**
- `selections` are immutable after insert. Corrections are new rows.

## Tip extraction

Posts are messy — emoji, screenshots, multi-leg lists, slang, mixed
languages, odds as "2.10" / "21/10" / "+110" / absent.

**Stage 1 — cheap filter.** Regex and keyword pass: is this plausibly a
tip? Cuts LLM spend by roughly 80%. Look for team names, market keywords
(over, under, btts, ht/ft, dc, handicap), odds patterns, bookmaker slip
codes.

**Stage 2 — LLM structured extraction.** `claude-sonnet-4-6`, strict JSON
schema, instructed to return JSON only with no markdown fences.

- Return an array — one post often holds 5–15 legs.
- `null` for anything not stated. Never infer odds that aren't written.
- A `confidence` float per selection; under 0.75 goes to the review
  queue, not the live pipeline.
- Normalize team names against the fixtures provider's canonical names
  with fuzzy matching plus a manual alias table. Budget real time here —
  "Man U" / "Man Utd" / "MUFC" / "Utd" is the permanent tax on this
  project.

Images matter. A large share of Telegram tips are bet-slip screenshots.
Pass them to the same model as base64 image blocks. Do not skip this.

## Settlement

Sweep for selections where `kickoff_utc + 150 minutes < now` and status
is null.

- Settlement rules are versioned pure functions, one per market
  (`settle_1x2`, `settle_ou`, `settle_btts`, `settle_ah`, …), each taking
  `(selection, result_payload)` and returning a status. Every one gets
  unit tests including the ugly cases: Asian handicap quarter-lines
  (half win / half push), void on postponement, abandonment, correct-score
  push conditions.
- Store `settlement_rule_version` per settlement so a rule fix triggers a
  targeted re-grade, not a full rebuild.
- Anything unhandled → `ungradeable`, excluded from ROI, surfaced in
  admin. Never guess a settlement.

## Reliability scoring

See `docs/SCORING.md` (verbatim, authoritative).

## Slip builder

Daily job. Input: selections from `RATED` sources, kickoff today,
`roi_ci_low > 0`, extraction confidence ≥ 0.75.

| Band | Target combined odds |
|---|---|
| A | 1.80 – 5.00 |
| B | 5.00 – 20.00 |
| C | 20.00 – 40.00 |
| D | 40.00 – 50.00 |
| E | 50.00 – 200.00+ |

1. Rank candidates by `roi_ci_low × log(n_settled)`.
2. Per band, greedy-fill from the top, then bounded local search
   (swap/add/drop, cap ~5000 evaluations) to land the product in range.
3. **Correlation guard, required.** Reject any slip with two legs from
   the same fixture. Penalize causally linked legs — two overs involving
   the same team, multiple legs from one competition on one matchday.
   Naive multiplication of correlated legs gives a wrong combined
   probability, and correlated legs die together.
4. Compute and display per slip: de-vigged true probability (product of
   implied probabilities) and the compounded bookmaker margin. On a
   10-leg accumulator that margin is typically 25–40%.
5. Cap at 12 legs. Always show the same selections as singles alongside,
   with the expected-value difference.
6. `legs_json` records which source each leg came from and that source's
   score at build time.

## Audit module (Aviator / virtuals)

Separate pipeline, separate screen, clearly labelled. Never feeds the
slip builder.

- Ingest claimed-signal posts into `audit_calls`.
- Record whether each call is verifiable at all: does it name a specific
  round, a specific target multiplier, and carry a timestamp before that
  round? Most won't. That unverifiable percentage is the headline
  finding — surface it as "X% of this account's calls cannot be
  checked."
- For verifiable calls, compare against the game's stated RTP baseline
  and run a binomial test against chance.
- Display per account: total calls, verifiable calls, hit rate, expected
  hit rate under chance, p-value, and simulated bankroll if every call
  were followed.
- **Hard rule: this module never feeds the slip builder, and the UI
  never renders an Aviator prediction as actionable.** It renders
  findings about accounts, not predictions about rounds.

## Mobile app

See `docs/DESIGN.md` (verbatim, authoritative) for the full design brief.

## Build and delivery — the APK

`.github/workflows/build-apk.yml`, triggered on push to `main` and via
`workflow_dispatch`.

- `expo prebuild --platform android` to generate the native project, then
  Gradle `assembleRelease`.
- Sign with a fixed keystore stored base64-encoded in a GitHub secret
  (`ANDROID_KEYSTORE_BASE64`, plus password/alias secrets), decoded at
  build time. Never commit the keystore. A fresh key each build makes
  the APK refuse to install over the previous one.
- Cache Gradle and npm to keep build times sane.
- Inject `EXPO_PUBLIC_API_URL` from secrets.
- Upload the APK with `actions/upload-artifact`, named
  `tipster-app-<short-sha>.apk`, retention 30 days.
- Set `versionCode` from the run number so successive installs upgrade
  cleanly rather than conflicting.
- `docs/STATUS.md` documents exactly how to download and install it from
  a phone, including the unknown-sources step, once Task 7 lands.

Task 7 (in the task table in `CLAUDE.md`) proves this workflow
end-to-end with a placeholder screen, before any real screens are built
in Task 8.
