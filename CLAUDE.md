# CLAUDE.md — Tipster Aggregator

This file is read at the start of every session. It must be enough, on its
own, for a session with no other context to work correctly. If you are
starting cold: read this file, then `docs/ARCHITECTURE.md`,
`docs/SCORING.md`, `docs/DESIGN.md`, and `docs/STATUS.md` (in that order)
before writing code.

## What this is

**Amended (Amendment B) — this is the current, primary description.** The
original plan was a tipster aggregator: ingest tip posts from Telegram,
Reddit, X, and Facebook, and score the accounts. That premise is now the
**deferred, optional path** (`sources.social.enabled`, default off — see
"Data sources" below). The primary system instead finds its own edge
directly in the odds market: it pulls fixtures and odds from a sharp
reference book (Pinnacle, via an aggregator API) and a soft book you
actually bet on, computes the fair (de-vigged) price from the sharp line,
and flags selections where the soft book's price is meaningfully better
than fair. It settles those selections against real results, scores the
resulting **strategies** (not tipster accounts) by ROI with CLV
(closing-line value) as the fast headline signal, and serves the
surviving high-confidence picks to a native Android app built with
Flutter (Amendment C — switched from the original Expo/React Native
plan). A separate audit-only track evaluates Aviator and virtual-match
"signal" accounts against chance — it never produces a slip, and is
unaffected by either amendment.

Why the change: the tipster-scoring machinery below exists to *find
someone with an edge*. Sharp bookmakers already price more accurately
than almost every tipster, and their prices are available over a plain
API — no cookies, no burner accounts, no ToS risk. See
`docs/ARCHITECTURE.md` § "Data sources — Amendment B" for the full
reasoning, provider evaluation, and honest caveats (edges are small,
consistently winning accounts get limited by soft books — this is a real
method, not a shortcut to free money).

## The two things that decide whether this is worth anything

1. **Snapshot every odds quote — never overwrite.** This is the
   odds-market equivalent of the original anti-cherry-picking rule, and
   it's just as load-bearing. `odds_snapshots` is append-only: every poll
   writes a new row, nothing is ever updated in place, and the last
   snapshot before kickoff is explicitly flagged as the **closing line**.
   Without the full price history you cannot compute CLV, and CLV is the
   only fast signal available before a strategy has hundreds of settled
   bets. (The original rule — `posts.captured_at` set by us at ingest,
   never parsed from the platform, gradeable only if `captured_at <
   kickoff_utc` — still applies verbatim if/when the social path is
   re-enabled; `selections` rows stay immutable after insert there too.)
2. **Rank by ROI, never hit rate — and treat CLV as the faster check.**
   92% accuracy on 1.05 odds loses money. Scoring ranks by `roi_ci_low`
   (the low end of a bootstrapped confidence interval on ROI), not point
   ROI and not win rate. **CLV is the headline metric above ROI**: ROI
   over 50 bets is mostly noise, CLV over 50 bets is real signal. A
   strategy with good ROI but negative CLV got lucky — show that
   explicitly, never let the ROI number stand alone. Full formulas and
   rules: `docs/SCORING.md` (original engine, verbatim) plus the
   Amendment B5 addendum at its end (strategies + CLV).

## Standing rules (apply to every session, not just the one that wrote this)

- **Never fabricate an API endpoint, package name, or field.** If you
  can't confirm it, stop and say so in the PR/status update. Guessed API
  shapes are the top failure mode on this project.
- **Never invent odds, results, or accuracy numbers.** Seed/test data
  lives in `fixtures/`, clearly marked, and never sits on a production
  code path.
- **Work in vertical slices.** Finish and prove one task before starting
  the next. Do not scaffold multiple modules at once.
- **One PR per task**, with the task number in the title (see
  `docs/STATUS.md` for the task list and current position).
- **Write tests alongside the code**, using real captured payloads where
  possible — not only synthetic fixtures.
- **Ask before adding a dependency** not already listed in the stack
  table below.
- **After each task, update `docs/STATUS.md`**: what works, what's
  stubbed, what's blocked, and what the next session should pick up.
- The Aviator/virtuals audit module (§ "Audit module" below) is
  read-only w.r.t. the slip builder: it must never feed selections into a
  slip, and the UI must never render an Aviator prediction as actionable.

## Stack

Cloud-first. Assume Windows on the developer's end, and no local machine
dependency at runtime — everything ships from GitHub Actions or a hosted
worker.

### Backend

| Layer | Choice | Notes |
|---|---|---|
| Language | Python 3.11 | |
| Polled ingestion | GitHub Actions cron | Odds, fixtures, results (Reddit/X deferred — see Data sources) |
| Telegram ingestion | Long-lived worker on Fly.io or Railway | MTProto needs a persistent session file on a volume |
| Database | Postgres — Supabase or Neon | Real transactions and window functions required; not SQLite |
| Queue | Postgres `SELECT … FOR UPDATE SKIP LOCKED` | No Redis at this volume |
| API | FastAPI + Pydantic v2 | |
| Extraction | Anthropic API, `claude-sonnet-4-6` | Structured JSON from unstructured posts |
| Secrets | GitHub Actions secrets + host env | Never in repo |

### Mobile

**Amended (Amendment C) — Flutter, not Expo/React Native.** The original
plan specified Expo/RN; that's reversed here while it was still free to
reverse (no mobile code had been written). Reference implementation:
[`lumeierecollection-blip/tradeapp`](https://github.com/lumeierecollection-blip/tradeapp),
path `signal_aggregator/` — a working Flutter app with its own
APK-to-artifact GitHub Actions pipeline, an adapter pattern
(`SignalSource`/`SourceRegistry`) that maps directly onto this project's
source-adapter needs, and several patterns worth porting (see
`docs/ARCHITECTURE.md` § "Build and delivery — the APK (Task B7)").

| Layer | Choice | Notes |
|---|---|---|
| Framework | Flutter (stable channel) | Real native app — not a webview, not a PWA |
| Language | Dart | |
| Navigation | Plain `Navigator` / `IndexedStack` tab shell | Matches `tradeapp`'s `app_shell.dart`; no router package needed at this scale |
| State | `provider` (`ChangeNotifier`) | Matches `tradeapp`; no separate data-fetching library |
| Motion | `AnimationController` + `SpringSimulation` | Non-negotiable — see `docs/DESIGN.md` §11.3/§11.3a |
| Gestures | Built-in `GestureDetector` / `Draggable` | No extra package needed |
| Materials | `BackdropFilter` + `ImageFilter.blur` | Flutter analogue of `backdrop-filter`; budget it, see §11.3a |
| Charts | Hand-rolled via `CustomPainter` | No chart library defaults |
| Styling | `theme.dart` token structure (`ThemeData`, `ColorScheme.fromSeed`) | Port `tradeapp`'s structure; drop `accentGradient` (§11.7), add tabular figures everywhere |
| Build | GitHub Actions → APK artifact | Port `tradeapp`'s `build-apk.yml` with 4 fixes — see `docs/ARCHITECTURE.md` |

Do **not** use Flutter's implicit animation widgets (`AnimatedContainer`,
`AnimatedOpacity`, `AnimatedPositioned`, `CurvedAnimation` with a fixed
`Duration`) on any surface the user can touch — they're fixed-duration
and non-interruptible, discard velocity, and restart from zero when
re-targeted. Use `AnimationController.animateWith(SpringSimulation(...))`
instead, seeded from the controller's current value and velocity. Full
detail in `docs/DESIGN.md` §11.3a.

## Data sources — summary (details in `docs/ARCHITECTURE.md`)

**Amendment B (current, primary path) — odds market, not tipsters:**

- **Odds:** OddsPapi (`https://api.oddspapi.io/v4`), pin confirmed live
  (Task B1b, 2026-08-13) against a real account — not secondary sources.
  **Pinnacle coverage is confirmed**: 10/10 probed Premier League
  fixtures returned priced Pinnacle odds. 350 bookmakers in the catalog;
  1xBet is listed but its live odds coverage wasn't confirmed (hit a
  rate limit mid-check, not a coverage failure). Requires a realistic
  `User-Agent` header or Cloudflare blocks the request. Likely **no
  South African bookmaker coverage** (not live-checked, but no evidence
  found and none expected) — the manual price check (§B4) is the primary
  way to use this for an SA book, not a fallback.
- **Fixtures + results:** API-Football (api-sports.io) — pin confirmed
  live (Task B1b): real account, Free plan, 100 requests/day. One open
  question from that same check: `/fixtures?date=...` returned 0 results
  for a 3-days-out date on the Free plan — needs investigating in B2
  (may need a competition filter rather than a bare date query).
- Cache hard, budget requests explicitly — free tiers are small.
- No cookies, no burner accounts, no proxy, no ToS risk on this path.

**Deferred, not deleted — social/tipster path (`sources.social.enabled`,
default off):**

- **Telegram** — Telethon (MTProto) or Bot API, persistent session file
  on a mounted volume. Was "primary source, built first" before this
  amendment; now optional. On `FloodWaitError`, sleep exactly the
  `seconds` value it carries — never retry blind.
- **X** — [Agent Reach](https://github.com/Panniantong/agent-reach)'s
  `twitter-cli` backend, headless via Cookie-Editor-exported cookies
  (`TWITTER_AUTH_TOKEN` + `TWITTER_CT0`, child-process env only, never
  argv). ToS-adjacent cookie access on a **burner account** — a leaked
  cookie pair is full account takeover.
- **Reddit** — PRAW is dead for new users (Reddit closed self-service API
  registration Nov 2025, confirmed independently). Agent Reach's
  `rdt-cli` backend instead — cookie auth, unmaintained upstream since
  March 2026.
- **Facebook** — deprioritized; Agent Reach's only backend (OpenCLI)
  needs a live desktop Chrome session, not viable headless.
- **Agent Reach** stays pinned to a commit SHA in `docs/ARCHITECTURE.md`
  — never tracks `main`. `pip install agent-reach` installs an unrelated
  package (name collision on PyPI); the pinned Git install is correct.
- `backend/ingestion/cli_runner.py` (Amendment A2) is built and stays —
  it's the shared subprocess runner this path will use whenever it's
  re-enabled.
- Budget for a residential proxy (Webshare, ~$1/month) if/when this path
  is re-enabled — both X and Reddit backends risk server-IP blocking.

## Docs map

- `docs/ARCHITECTURE.md` — data model, ingestion/extraction/settlement
  pipeline, adapters.
- `docs/SCORING.md` — the ROI scoring formula, confidence intervals,
  sample gates, and disqualifiers (source of truth, brief §7, verbatim),
  plus the Amendment B5 addendum at the end of the file (strategies
  terminology, CLV as headline metric) — the addendum amends the
  verbatim text above it, it doesn't replace it. Slip-building rules
  (brief §8) and the audit module (brief §9) are summarized in
  `docs/ARCHITECTURE.md`.
- `docs/DESIGN.md` — mobile design brief: motion system, materials,
  typography, screens, anti-defaults (source of truth, brief §11).
- `docs/STATUS.md` — current state: what works, what's stubbed, what's
  blocked, task list and position, APK download/install instructions.

## Task order

One PR per task, in order. Do not run ahead of the current position
recorded in `docs/STATUS.md`.

**Active plan (Amendment B — odds-market path, current):**

| # | Task | Status |
|---|---|---|
| B1 | Evaluate providers, confirm SA bookmaker and Pinnacle coverage, pin choices | Done — provisional, see caveat above |
| B2 | Fixtures + odds ingestion, `odds_snapshots`, closing-line capture | Next |
| B3 | De-vigging, edge calculation, sanity gates | |
| B4 | Manual price check API + screen | |
| B5 | Repoint scoring to strategies, add CLV | |
| B6 | Settlement against real results (original §6/Task 3, unchanged machinery) | |
| B7 | Flutter app scaffold + APK build workflow, ported from `tradeapp` — demo mode removed; real odds/fixtures data exists by the time this lands, so screens have real content from the start | |

B7 is deliberately last in this plan, not first — B2's data lands within
days, so by the time the app is built there's something real to show
instead of a demo-data banner. This differs from the original brief's
Task 7-before-8 ordering; the reason (prove the build pipeline before UI)
is unchanged, it's just that "before UI" no longer means "before there's
any data at all."

**Deferred plan (original main brief — social/tipster path, on hold
behind `sources.social.enabled`):**

| # | Task |
|---|---|
| 0 | Repo skeleton + `CLAUDE.md` + docs — done |
| 1 | Postgres schema + Telegram ingest for 3 channels — schema will be shared with the odds-market path; Telegram-specific ingest deferred |
| 2 | Two-stage extractor (text) + fixture matching + review queue |
| 9 | Reddit adapter (Amendment A5), image extraction, audit module — A1/A2 (research, `cli_runner.py`) already done and kept |
| 10 | X adapter (Amendment A4) |

Do not resume this plan until the odds-market path (B1–B7) is working
end to end, per the amendment's own priority.

## Audit module (Aviator / virtuals)

Separate pipeline, separate screen, clearly labelled. Measures claimed
"signal" accounts against chance (binomial test vs. stated RTP baseline)
and reports what fraction of their calls are even verifiable. It **never**
emits a slip and the UI never renders one of its findings as an
actionable prediction. Full rules in `docs/SCORING.md`.
