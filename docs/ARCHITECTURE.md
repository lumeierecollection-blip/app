# Architecture

This is a working summary of the system's pipeline, data model, and
adapters. `docs/SCORING.md` is the verbatim, authoritative source for
reliability scoring — this file summarizes the stages around it. When the
two disagree, `docs/SCORING.md` wins for anything scoring-related.

## What the system does

**Amended (Amendment B) — this is the current, primary flow.** The
original plan (ingest and score tipster accounts from social platforms)
is preserved below as a deferred, optional path
(`sources.social.enabled`, default off). See "Data sources — Amendment B"
and "Data sources — deferred" for the split.

1. Pulls fixtures and odds for upcoming matches from a fixtures/results
   API and an odds API, and snapshots every odds quote — never
   overwritten, with the closing line (last snapshot before kickoff)
   explicitly flagged.
2. Computes the fair, de-vigged probability from a sharp reference
   book's price and flags a **selection** where a soft book's offered
   price gives a meaningful edge over that fair price (or, via the
   manual price check, where a bookmaker odds value you type in does).
3. Settles each selection against real results after the fixture
   completes.
4. Maintains a rolling ROI-based reliability score per **strategy**
   (competition + market type + edge threshold + source book, not a
   social account), with confidence intervals, a minimum-sample gate, and
   CLV (closing-line value) as the fast headline signal (see
   `docs/SCORING.md`).
5. Assembles surviving high-confidence, genuinely +EV selections into
   daily accumulator slips across five odds bands.
6. Runs an audit-only track for Aviator and virtual matches, unaffected
   by this amendment.
7. Serves all of it to a native Android app.

Deferred path, same shape, kept behind the flag: ingest tip posts from
Telegram/Reddit/X/Facebook, parse into selections, snapshot at capture
time (`captured_at < kickoff_utc` gate), settle, score tipster accounts
by ROI. Full detail in "Data sources — deferred" below.

## Data sources — Amendment B (primary, odds-market path)

Replaces the original §3 (and supersedes the earlier Agent Reach
amendment as the *primary* ingestion path — that work is deferred, not
deleted; see below). The reasoning: the tipster-scoring machinery exists
to find someone with an edge, but a sharp bookmaker already prices more
accurately than almost any tipster, and that price is available over a
plain API with no cookies, no burner accounts, no ToS risk, and no
blocked tasks.

### Odds — OddsPapi (live-confirmed, Task B1b, 2026-08-13)

**The provider pin moved from "The Odds API" to OddsPapi** in a prompt
this session never received (referenced as "Prompt 5" by a later one) —
noted here rather than silently smoothed over, since `docs/STATUS.md`
records the gap. OddsPapi is now confirmed against a real account, not
secondary sources: `scripts/verify_providers.py`, run via
`.github/workflows/verify-providers.yml` (manual-trigger, since this
session's sandbox has no general web egress — confirmed via both a
direct `curl` through the environment's proxy and the `WebFetch` tool
failing even on Wikipedia). Raw responses saved to
`fixtures/provider_probes/`.

- **Pinnacle coverage: confirmed live.** `/v4/odds-by-tournaments` for
  Premier League (tournamentId 17) with `bookmaker=pinnacle` returned 10
  fixtures, all 10 with priced odds. This was the single fact the whole
  method depended on, and it now has a real, positive answer — not an
  assumption.
- Base URL `https://api.oddspapi.io/v4`, `apiKey` as a query parameter.
  **Requires a realistic `User-Agent`/`Accept` header** — the first live
  run failed outright with a Cloudflare "error code: 1010" bot-block
  using `urllib`'s default User-Agent; fixed in the probe script and
  confirmed working on the next run.
- Full bookmaker catalog: 350 bookmakers. Confirmed present by name:
  Pinnacle, 1xBet.
- **1xBet: listed in the catalog, but live odds coverage not confirmed**
  — the `odds-by-tournaments` call for `bookmaker=1xbet` hit a 429 rate
  limit (`retryMs: 588`) before it could return a result. Not a coverage
  failure, just an untested one; a follow-up probe with request spacing
  would resolve it, but nothing downstream depends on 1xBet specifically
  the way it depends on Pinnacle.
- **Rate limiting is per-endpoint and communicated in the 429 response
  body** (`error.retryAfter`/`error.retryMs`), not in response headers —
  confirmed by the empty `rate_limit_headers` result on both the
  successful and rate-limited calls. Task B2's polling code needs to
  read and respect that body field for backoff; header-sniffing won't
  see it.
- **No live check was done for South African bookmaker coverage
  specifically** (only Pinnacle and 1xBet were probed). Secondary-source
  research still says likely none — treat that as probable, not
  confirmed, and the manual price check (Task B4) is still the primary
  way to use this system against a South African book either way.
- Tournament catalog for football/soccer alone: 1,762 tournaments —
  confirms this isn't a thin dataset.

### Fixtures and results — API-Football (api-sports.io) — live-confirmed

Confirmed against a real account (same B1b run): Free plan, active,
`requests.limit_day: 100` — matches the secondary-source figure from the
original B1 pass. Auth via the `x-apisports-key` header, base
`https://v3.football.api-sports.io`.

**One real finding worth investigating in B2, not yet explained:**
`/fixtures?date=<3-days-out>` returned 0 results on the Free plan. Could
be genuinely no matches that day across every competition API-Football
covers (possible but would be unusual for a global, all-competitions
query), or the Free plan could restrict bare date queries and require a
`league`/competition filter — B2 should test both before assuming either.

**A privacy incident happened during this verification and was fixed at
the source, not just patched over:** `/status`'s real response includes
the account holder's name and email in an `account` block alongside the
`subscription`/`requests` fields this project actually needs. The first
live run saved and printed it unfiltered — it reached a build artifact
and job logs (not a git commit; that step only runs after a successful
probe, and that run failed for an unrelated reason first). Fixed with a
recursive PII scrub (`_scrub_account_pii` in `scripts/verify_providers.py`)
that strips any `account` key before anything is saved, logged, or
printed, confirmed both by a test and by the next live run's clean
output. If any script or adapter calls `/status` again later, it must
go through the same scrub — this isn't a one-off cleanup, it's a
standing rule for this endpoint.

### Budget discipline

Cache aggressively and design the poll schedule around the credit/request
budget explicitly (Task B2) — a naive polling loop exhausts a free tier's
monthly allowance in a day. Quota exhaustion becomes the silent-failure
mode for this path, in exactly the way cookie expiry was for the social
path — the Health screen (Task B7) needs to surface it the same way
`ingestion_health` was designed to surface doctor failures.

## Data sources — deferred (social/tipster path, `sources.social.enabled`, default off)

Everything in this section is preserved, not deleted — Amendment B just
demoted it from primary to optional. Re-enable it as a later input once
the odds-market path (B1–B7) is working end to end. The original
reasoning for each platform below still holds; only its priority changed.

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

## Ingestion architecture — social path (deferred, `sources.social.enabled`)

The subsections below (subprocess contract, doctor preflight, credential
lifecycle, scheduling) describe how the deferred social/tipster path
would ingest via Agent Reach. None of it runs by default; it's preserved
so re-enabling the flag is a config change, not a rebuild. The primary
path's ingestion mechanics (odds/fixtures polling, `odds_snapshots`) are
in "Ingestion architecture — odds-market path" further below.

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

### Task order for this amendment — deferred, on hold behind the flag

Amendment B demoted this whole path from primary to optional. A1/A2 are
done and kept as-is (research doesn't rot, and `cli_runner.py` is
reusable infra with no live-credential dependency). A3–A7 are on hold,
not abandoned — resume them only once the odds-market path (B1–B7) is
working end to end and there's a reason to re-enable
`sources.social.enabled`.

| # | Task | Status |
|---|---|---|
| A1 | Read the repo, write findings here, pin the SHA | Done |
| A2 | `cli_runner.py` + credential redaction + timeout handling, with tests | Done |
| A3 | Doctor preflight + `ingestion_health` table + skip-vs-warn distinction | On hold (Amendment B) |
| A4 | X adapter via `twitter-cli`, with liveness probe | On hold (Amendment B) — was also blocked on a burner X account |
| A5 | Reddit: `rdt-cli` adapter (official-API path confirmed unavailable, see above) | On hold (Amendment B) — was also blocked on a burner Reddit account |
| A6 | `docs/RUNBOOK.md` + automatic issue-on-failure | On hold (Amendment B) |
| A7 | Health surfacing in the mobile app | On hold (Amendment B) — superseded by B7's Health screen, which reports odds-market quota/staleness instead |

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

## Ingestion architecture — odds-market path (Amendment B, primary)

Runs on GitHub Actions cron, same infrastructure pattern as the deferred
path but no CLI subprocesses, no cookies — plain HTTPS calls to two REST
APIs, cached and budgeted against their free-tier limits (Task B2).

- Pull fixtures for the next 7 days for configured competitions from
  API-Football.
- Poll odds for each fixture on a widening-then-tightening schedule: on
  discovery, then at widening intervals, then every 15 minutes in the
  final 2 hours before kickoff — line movement near kickoff carries the
  most information, and this is also where the request budget should be
  concentrated rather than spread evenly.
- **Every odds snapshot is stored, never overwritten** — this is the
  direct equivalent of the post-time snapshotting rule from the original
  brief, and just as load-bearing: without the full price history there
  is no CLV, and CLV is the only fast signal available before a strategy
  has hundreds of settled bets. New table: `odds_snapshots` (see Data
  model below).
- The **closing line** — the last snapshot before kickoff — is captured
  and flagged explicitly. It's the single most valuable field in the
  database: every CLV calculation reads from it.
- Track API credit/request consumption per run and surface it on the
  Health screen (B7) — quota exhaustion here is the equivalent
  silent-failure mode that cookie expiry was for the social path: the
  job can run "successfully" and simply stop finding anything because
  the quota is gone.

### Implementation (Task B2, built)

`backend/db/migrations/` (5 SQL files, applied by `backend/db/migrate.py`)
and `backend/ingestion/odds/` — provider adapters
(`api_football_provider.py`, `oddspapi_provider.py`), the
`SignalSource`/`SourceRegistry`-derived `OddsProviderRegistry`
(`registry.py`, real thread-pool concurrency), fixture identity
resolution (`fixture_matching.py`), the poll scheduler (`poller.py`),
storage including closing-line finalization (`storage.py`), and the
pipeline entrypoint (`run_once.py`). 80 tests, run with `cd backend &&
DATABASE_URL=postgresql://... python3 -m pytest` — a real local
Postgres 16, not a mock.

**Two real parsing details found only by testing `OddsPapiProvider`
against the actual captured B1b payload, not assumed from the
documented shape:**

- A fixture's `bookmakerOdds[bookmaker].markets` has ~36 entries, and
  outcome ids like "home"/"draw"/"away" are **not unique across
  markets** — a second period (likely a half; not independently
  confirmed which) has its own moneyline market with the same outcome
  ids and materially different real prices. `bookmakerMarketId`'s
  period segment (the second-to-last "/"-separated component) has to be
  checked alongside the outcome id; period `"0"` is the full match, and
  is the only one this project ingests.
- Totals markets carry roughly 10 alternate lines per fixture, all
  `mainLine: false`, plus one `mainLine: true` designated main line.
  Only the main line is ingested — the alternates are real data, just
  out of scope for what Task B3's de-vig math needs right now.

**One gap, not yet live-confirmed:** resolving OddsPapi's
`participant1Id`/`participant2Id` to team names needs a `/v4/participants`
call whose exact parameter shape isn't documented anywhere this session
could verify — built as the best available guess (matching every other
confirmed endpoint's `?<idsParam>=X,Y&apiKey=...` convention), and it
will raise clearly, not silently mis-resolve, if that guess turns out
wrong. `.github/workflows/ingest-e2e.yml` (manual-trigger, spins up a
Postgres 16 service container in CI — no persistent database needed to
prove this) is written to confirm or correct it, pending a human
trigger (same permission gap that blocked `verify-providers.yml`'s
first dispatch).

## Fair price and value detection (Task B3)

1. **De-vig the sharp book's prices** to get fair probabilities.
   Multiplicative de-vigging (each implied probability divided by the sum
   of all implied probabilities in the market) is fine for two-way
   markets. For three-way markets (1X2) it's biased — it systematically
   overprices longshots, because a draw or a big underdog absorbs more of
   the vig proportionally than its true probability would justify. Use
   **Shin's method** or the **power method** for 1X2 instead, and the
   code implementing it must say in a comment which one and why — this
   is exactly the kind of choice that looks interchangeable until it
   silently biases every longshot selection in one direction.
2. **Fair odds** = 1 / fair probability.
3. **Edge** = (offered odds × fair probability) − 1.
4. Flag a selection when edge exceeds a configurable threshold (start at
   2%, make it a setting — not a constant, since the right threshold is
   an empirical question this system doesn't have data to answer yet).
5. **Sanity gates, all required, and each rejection logged with its
   reason** — a large apparent edge is almost always a data error, not an
   opportunity:
   - reject if the sharp book's price is stale beyond a few minutes
   - reject if the two books are pricing different lines (an AH −0.5
     against an AH −0.75 is not the same bet, and comparing them produces
     a nonsense edge)
   - reject if the market looks suspended or the price is an obvious
     outlier
   - reject on low liquidity or very early lines (before the market has
     found its price)

## Manual price check (Task B4)

The mode that works regardless of bookmaker API coverage, and — given no
confirmed South African bookmaker coverage on the odds API (see above) —
the primary way this system gets used against a South African book, not
a fallback.

- Pick a fixture and market; the app shows the fair probability and fair
  odds computed from the sharp line (same de-vig math as B3).
- Type in what your bookmaker is actually offering; the app returns the
  edge and, if positive, a stake-fraction recommendation.
- Every check is stored in `manual_checks` with the fair line **at the
  time of the check**, so these get graded and scored exactly like
  automatically-detected selections once the fixture settles — this
  table is not a scratchpad, it's a source of real, scoreable strategies.
- Optimize the input path for speed: a large numeric keypad, one-handed
  operation, no navigation between entering a price and seeing the
  answer. Reachable in one tap from the home screen — this is meant to
  be used in the 10 seconds before placing a real bet, not as a research
  tool you sit down with.

## Scoring — repointed to strategies (Task B5)

Full formulas and the exact addendum text live in `docs/SCORING.md`
(Amendment B5, appended after the verbatim §7). Summary: the same
engine — ROI, bootstrap CI, `roi_ci_low` ranking, 50-sample minimum gate,
decay, disqualifiers — now grades **strategies** (competition + market
type + edge threshold + source book) instead of tipster accounts, and
**CLV is added as the headline metric shown above ROI** on every screen,
since CLV over 50 bets is real signal where ROI over 50 bets is mostly
noise. A strategy with good ROI but negative CLV must be shown as having
gotten lucky, not presented as if the ROI figure alone were trustworthy.

## Data model (Postgres)

Amendment B adds the primary-path tables (`fixtures`, `odds_snapshots`,
`strategies`, `strategy_scores`, `manual_checks`) and extends
`selections` with an `origin` so settlement/scoring/slips can operate on
it uniformly regardless of where a selection came from. `sources`,
`posts`, and `source_scores` are the deferred social-path tables —
unchanged, kept for whenever `sources.social.enabled` is on.

**Built, Task B2** (`backend/db/migrations/`, real SQL, not just this
sketch): `fixtures`, `odds_snapshots`, `strategies`, `manual_checks`,
`ingestion_health`. **Not yet built**: `selections` (with `origin`),
`settlements`, `strategy_scores`, `slips`, `audit_calls`, and the
deferred-path tables (`sources`, `posts`, `source_scores`) — land with
B3/B5/B6 and whenever the social path resumes, respectively.

```
-- Amendment B — primary, odds-market path

fixtures         id, competition, home, away, kickoff_utc, status,
                 provider_fixture_id, created_at

odds_snapshots   id, fixture_id, bookmaker, market, selection, line,
                 odds, captured_at, is_closing_line
                 -- append-only: a poll always inserts, never updates.
                 -- is_closing_line is set on the last snapshot written
                 -- before kickoff_utc for that fixture/bookmaker/market.

strategies       id, competition, market_class, edge_threshold,
                 source_book, active, first_seen
                 -- the thing that gets scored; replaces a tipster
                 -- "source" for auto-detected selections

manual_checks    id, fixture_id, market, pick, line, fair_probability,
                 fair_odds, entered_odds, entered_bookmaker, edge,
                 stake_fraction, checked_at, selection_id
                 -- every check is logged here regardless of outcome;
                 -- selection_id is set only if the user confirms they
                 -- actually placed the bet, which promotes it into a
                 -- selections row for scoring

strategy_scores  strategy_id, window(30d|90d|all), n_settled, roi,
                 roi_ci_low, roi_ci_high, hit_rate, avg_odds, mean_clv,
                 pct_positive_clv, longest_losing_run, computed_at
                 -- same shape as the deferred path's source_scores,
                 -- plus mean_clv / pct_positive_clv (Amendment B5)

-- Shared by both paths

selections       id, origin(social|auto_odds|manual_check), post_id,
                 fixture_id, strategy_id, sport, competition, home, away,
                 kickoff_utc, market, pick, line, claimed_odds,
                 verified_odds, verified_odds_source, bookmaker,
                 fair_probability, fair_odds, edge,
                 confidence_extraction, extraction_model, created_at
                 -- post_id set only when origin=social; fixture_id set
                 -- for the other two origins

settlements      selection_id, status(won|lost|void|push|ungradeable),
                 settled_at, result_payload, settlement_rule_version

slips            id, band(A|B|C|D|E), target_min_odds, target_max_odds,
                 combined_odds, legs_json, built_at, status, settled_at

-- Unaffected by Amendment B

audit_calls      id, source_id, game(aviator|virtual_football|...),
                 claimed_target, claimed_outcome, verifiable(bool),
                 posted_at, captured_at, notes

-- Deferred, social path (sources.social.enabled, default off)

sources          id, platform, handle, display_name, first_seen, active,
                 followers_at_capture, notes

posts            id, source_id, platform_post_id, captured_at, posted_at,
                 raw_text, raw_json, media_urls, edited_flag, edited_at,
                 content_hash, deleted_detected_at

source_scores    source_id, market_class, window(30d|90d|all),
                 n_settled, roi, roi_ci_low, roi_ci_high, hit_rate,
                 avg_odds, longest_losing_run, computed_at
```

**Non-negotiable constraints:**

- `odds_snapshots` is append-only — a poll always inserts a new row,
  never updates one in place. This is the primary path's equivalent of
  post-time snapshotting: without the full price history there is no
  CLV, and CLV is the only fast signal available before hundreds of bets
  settle.
- `posts.captured_at` (deferred path) is set by us at ingest. Never
  parsed from the platform.
- `content_hash` (deferred path) hashes the tip's semantic content at
  capture. Later divergence flags the post as edited and disqualifies
  it.
- A social-origin selection is gradeable only if `captured_at <
  kickoff_utc`. Anything captured after kickoff is stored but
  permanently excluded from scoring. **This is the rule that stops fake
  tipsters gaming the system**, on whichever future session re-enables
  that path.
- `selections` are immutable after insert, regardless of origin.
  Corrections are new rows.

## Tip extraction (deferred, social path only)

Only applies to `origin=social` selections — Amendment B's `auto_odds`
and `manual_check` selections are computed directly from odds snapshots
and typed-in prices, no LLM extraction involved. On hold along with the
rest of the social path.

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

## Settlement (Task B6 — unchanged machinery, now settles both origins)

Unaffected by Amendment B (its own B6 explicitly says so) — this settles
`selections` regardless of `origin`, auto-detected odds-market picks and
manual checks exactly the same way it would settle a social tip.

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

Daily job. Input: selections from `RATED` strategies/sources, kickoff
today, `roi_ci_low > 0`, extraction confidence ≥ 0.75 (social-origin
only — `auto_odds`/`manual_check` selections use edge above the
configured threshold in place of extraction confidence).

**Amendment B addition: only genuinely +EV legs may enter a slip.**
Combining legs with no edge just compounds the bookmaker's margin —
this applies on top of, not instead of, the `roi_ci_low`/sample-gate
filtering below. The margin and true-probability display in step 4 stays
exactly as specified; with real edges now driving selection it becomes
the safety surface `docs/DESIGN.md` §11.6 describes, not just a warning
label on a demo.

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

## Build and delivery — the APK (Task B7)

**Amendment C: Flutter, not Expo/React Native — ported from
[`lumeierecollection-blip/tradeapp`](https://github.com/lumeierecollection-blip/tradeapp),
path `signal_aggregator/` (verified by cloning and reading it, not
assumed from the amendment's description).** This reverses the earlier
Expo/RN choice while it was still free to reverse: no mobile code exists
yet, Task B7 hasn't started, and the Python backend is unaffected either
way. Reasons: `tradeapp` has a *working* APK-to-artifact pipeline
already producing installable builds (collapsing the riskiest part of
this task from "debug Gradle/Babel/New-Architecture defaults from
scratch" to "copy something proven and fix its known bugs"), its
`SignalSource`/`SourceRegistry` adapter pattern is the same shape this
project already needs for `OddsProvider`/`ProviderRegistry`, and
Flutter's `SpringDescription.withDampingRatio` maps onto Apple's
damping/response model at least as cleanly as Reanimated does. Full
Flutter translation of the design system: `docs/DESIGN.md` §11.3–11.5
and the new §11.3a addendum.

**Amendment B7 still holds: demo mode is removed from this task
entirely.** The original spec (superseded) had the app ship a demo-data
mode — fixtures from a committed `demo.json`, a persistent "DEMO DATA"
banner — because there was no real data yet at the time the APK had to
be proven. That premise is gone: B2 lands real fixtures/odds within
days, so by the time this task runs there's real content to show. No
fixtures screen, no banner, no `demo.json`, ever. The app talks to the
real API from the start; if the API is unreachable, the right behavior
is a normal loading error, not synthetic data standing in for it.

**Do the placeholder-first proof before building anything else in this
task** — one screen, "hello", signed, downloaded, installed on a phone —
before writing app-shell or design-system code. This is cheaper now than
originally planned (a proven workflow exists to copy), but the ordering
reason is unchanged: don't debug a broken Gradle config and a broken UI
at the same time.

### Workflow — port `tradeapp`'s `build-apk.yml`, fix four real bugs

Read directly from `tradeapp`'s `.github/workflows/build-apk.yml`: it
works (Java 17, `subosito/flutter-action@v2` with caching,
`flutter analyze` and `flutter test` gating the build,
`if-no-files-found: error` on the upload) but has exactly the failure
modes this project's own subprocess/doctor work already learned to
avoid. Copy the workflow, keep everything above, fix these four,
confirmed present in the source file:

1. **Silent debug fallback (the big one).** The source workflow checks
   for `KEYSTORE_BASE64` and builds `flutter build apk --debug` if it's
   absent, instead of failing. Debug and release use different signing
   keys, so a debug APK won't install over a release build — the user
   uninstalls, loses app data, and nothing told them why. **Fail the job
   if the keystore secret is missing; never fall back to debug
   signing.**
2. **No `versionCode` from the run number.** Neither `flutter build apk`
   invocation passes `--build-number`. Successive builds carry the same
   version, so Android may refuse the upgrade. Add
   `--build-number=${{ github.run_number }}`.
3. **Fixed artifact name** (`signal-aggregator-apk` in the source). You
   can't tell which commit you installed from the artifact name alone.
   Use `tipster-<short-sha>.apk`.
4. **Triggers on `push` *and* `pull_request`.** Two APK builds per PR for
   no benefit. Restrict to `push: [main]` plus `workflow_dispatch`.

- Fixed signing keystore, same naming as the original Expo-era plan:
  `ANDROID_KEYSTORE_BASE64` (base64), plus `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Never committed, never
  echoed.
- `EXPO_PUBLIC_API_URL` becomes **`API_BASE_URL`, read via `--dart-define`**
  — decided and recorded here at the start of B7. Wired through as a
  repo secret in `build-apk.yml`
  (`--dart-define=API_BASE_URL=${{ secrets.API_BASE_URL }}`), read at
  compile time via `String.fromEnvironment('API_BASE_URL')` in
  `mobile/lib/main.dart`. Demo-mode-free requirement holds: if the value
  is empty, the app shows a real error screen, not fallback data.

### App shell

Tabs matching `docs/DESIGN.md` §11.8's labels — Slips, Tipsters, Audit —
plus Health and Admin, using the plain `Navigator`/`IndexedStack` pattern
`tradeapp`'s `app_shell.dart` already demonstrates (see the Mobile stack
table in `CLAUDE.md`) rather than adding a router package. Every screen
ships its real empty state (no stock illustrations, no emoji, per
§11.7), since empty states are where this app spends its first weeks.

**Health screen — build this properly, it's the one immediately useful.**
Per the odds-market path: last successful fixtures/odds poll per
competition, API quota consumed, and staleness of the sharp line. Per
the (currently disabled) social path, if re-enabled: current backend,
last successful run, credential age. Clear visual distinction between
"unhealthy" and "no edges found right now" — those are different facts
and must never look the same, for the same reason `doctor`'s `off`/`warn`
distinction mattered in the deferred path.

### Design system — Flutter translation

Full detail in `docs/DESIGN.md` §11.3–11.5 and §11.3a. Build
`mobile/theme/` (or the Flutter-idiomatic equivalent path) before any
screen work, loading `.claude/skills/apple-design/SKILL.md` first:
`motion.dart` (the three precomputed `SpringDescription` values from
§11.3a — nothing defines a spring inline), a type scale using
`FontFeature.tabularFigures()` on every numeric style, `color.dart`
(semantic won/lost/void paired with a glyph, never colour alone), and
the `BackdropFilter` chrome treatment with the in-app reduce-transparency
setting §11.3a specifies (Flutter has no OS-level signal for this,
unlike reduce-motion/high-contrast, which do exist). Include the §11.2
stillness-in-data-views comment in the code so a later session doesn't
"fix" it by adding animation.

### Patterns to port from `tradeapp` (verified against the real files)

| From `tradeapp` (`signal_aggregator/lib/...`) | To this app | Note |
|---|---|---|
| `services/sources/signal_source.dart` + `source_registry.dart` — `SignalSource` abstract class, `SourceRegistry.fetchAll` (parallel `Future.wait`, dedupe by id, sort by timestamp) | `OddsProvider` / `ProviderRegistry` (Task B2) | Direct port of the adapter pattern, same shape this project already specified independently |
| `services/paper_trader.dart` — `PaperTrader`, balance/open-trades/closed-trades/PnL, all persisted via `Storage` | Paper-betting mode, **default on** | Exactly how to accumulate the §7 50-selection sample gate and prove CLV before staking anything real |
| `models/validated_signal.dart` — `FactorScore.plain`, a one-sentence plain-English explanation per factor | One-sentence plain-English rationale per selection (why it's +EV) | Genuinely good pattern, better than most production apps |
| `ui/theme.dart` — `ColorScheme.fromSeed`, structured `ThemeData` | `theme.dart` structure | Port the structure; **drop `accentGradient`** (confirmed present at `theme.dart:23-27` — §11.7 anti-defaults forbid gradients); add `FontFeature.tabularFigures()` to every numeric style (`tradeapp` only applies it to one, `clockStyle`) |
| `services/storage.dart` — `SharedPreferences`-backed key/value store | Local cache of selections and paper-betting results | Same simple persistence pattern, no need for anything heavier at this scale |

**Two things confirmed by reading `tradeapp`, not ported:**

- `services/sources/reddit_source.dart` fetches `reddit.com/r/<sub>/new.json`
  anonymously and silently swallows all fetch errors per-subreddit
  ("Skip failing subreddits silently"). This is the *exact* endpoint
  Agent Reach's `reddit.py` documents as 403-blocked by anti-bot
  measures (see "Data sources — deferred" above) — independent
  confirmation of that finding from a second, unrelated codebase. A dead
  source returning an empty list is indistinguishable from "no signals
  today" without exactly the kind of health/skip-vs-empty tracking this
  project's own doctor-preflight design (deferred, Task A3) exists to
  catch. Worth checking whether that source has been silently dead.
- `services/validator.dart`'s `Validator` assigns "probability" from
  hand-chosen factor weights (momentum 30%, volume 20%, RSI 20%, entry
  zone 20%, message clarity 10% — confirmed exact percentages in the
  source comments). Those weights were picked, not fitted, so the output
  is an index, not a calibrated probability. **Do not port this
  approach.** This project's de-vigged market price (Amendment B3) is
  derived from real money at risk, which is a fundamentally stronger
  basis than a hand-tuned heuristic — the two aren't a fair swap, and
  porting the weighting logic would quietly downgrade what B3 already
  provides. Related: `tradeapp`'s `PaperTrader.highConfidenceAccuracy`
  measures win rate — for this project that's the exact metric
  `docs/SCORING.md` says lies (§7, ROI over hit rate); the closest
  equivalent here reports ROI and CLV, never a bare accuracy number.

### Install instructions

`docs/STATUS.md` documents, written to be followed on a phone: finding
the Actions run, downloading and unzipping the artifact, enabling
install-from-unknown-sources, installing, and verifying the installed
build matches the expected commit — once this task lands.
