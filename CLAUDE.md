# CLAUDE.md — Tipster Aggregator

This file is read at the start of every session. It must be enough, on its
own, for a session with no other context to work correctly. If you are
starting cold: read this file, then `docs/ARCHITECTURE.md`,
`docs/SCORING.md`, `docs/DESIGN.md`, and `docs/STATUS.md` (in that order)
before writing code.

## What this is

A system that ingests betting-tip posts from Telegram, Reddit, X, and
(best effort) Facebook, snapshots them immutably at capture time, settles
them against real results, scores each source by ROI (not hit rate), and
serves the surviving high-confidence picks to a native Android app built
with Expo/React Native. A separate audit-only track evaluates Aviator and
virtual-match "signal" accounts against chance — it never produces a slip.

## The two things that decide whether this is worth anything

1. **Snapshot every tip at post time.** Tipsters delete their losers.
   Grading an account by reading its timeline later makes every account
   look like a genius. `posts.captured_at` is set by us at ingest, never
   parsed from the platform, and a selection is gradeable only if
   `captured_at < kickoff_utc`. Anything captured after kickoff is stored
   but permanently excluded from scoring. This is the single rule that
   stops fake tipsters gaming the system. `selections` rows are immutable
   after insert — corrections are new rows, never updates.
2. **Rank by ROI, never hit rate.** 92% accuracy on 1.05 odds loses money.
   Scoring ranks by `roi_ci_low` (the low end of a bootstrapped confidence
   interval on ROI), not point ROI and not win rate. Full formula and
   rules: `docs/SCORING.md`.

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
| Polled ingestion | GitHub Actions cron | Reddit, odds, results |
| Telegram ingestion | Long-lived worker on Fly.io or Railway | MTProto needs a persistent session file on a volume |
| Database | Postgres — Supabase or Neon | Real transactions and window functions required; not SQLite |
| Queue | Postgres `SELECT … FOR UPDATE SKIP LOCKED` | No Redis at this volume |
| API | FastAPI + Pydantic v2 | |
| Extraction | Anthropic API, `claude-sonnet-4-6` | Structured JSON from unstructured posts |
| Secrets | GitHub Actions secrets + host env | Never in repo |

### Mobile

| Layer | Choice | Notes |
|---|---|---|
| Framework | React Native via Expo (managed, prebuild) | Real native app — not a webview, not a PWA |
| Language | TypeScript, strict | |
| Navigation | `expo-router` | |
| Motion | `react-native-reanimated` v3 | Non-negotiable — see `docs/DESIGN.md` §11.3 |
| Gestures | `react-native-gesture-handler` | Needed for release velocity |
| Materials | `expo-blur` | RN analogue of `backdrop-filter` |
| Data | TanStack Query | Caching, refetch, offline behaviour |
| Charts | Hand-rolled SVG via `react-native-svg` | No chart library defaults |
| Styling | Token file + `StyleSheet` | NativeWind optional; ask before adding |
| Build | GitHub Actions → APK artifact | See `docs/STATUS.md` for build/install instructions |

Do **not** use `Animated` from React Native core — use Reanimated. Core
`Animated` drops frames on data-heavy lists and cannot deliver the
interruptible, velocity-aware motion `docs/DESIGN.md` requires.

## Data sources — summary (details in `docs/ARCHITECTURE.md`)

**Amended from the original plan** — see "Ingestion architecture" in
`docs/ARCHITECTURE.md` for the full reasoning and verified findings.

- **Telegram** — primary source, built first, unaffected by the
  amendment. Telethon (MTProto) or Bot API. Persistent session file on a
  mounted volume. On `FloodWaitError`, sleep exactly the `seconds` value
  it carries — never retry blind.
- **X** — no paid API needed. [Agent Reach](https://github.com/Panniantong/agent-reach)'s
  `twitter-cli` backend runs headless on Cookie-Editor-exported cookies
  (`TWITTER_AUTH_TOKEN` + `TWITTER_CT0`, child-process env only, never
  argv). This is ToS-adjacent cookie access on a **burner account** — a
  leaked cookie pair is full account takeover. Prefer stable commands
  (`feed`, `user-posts`) over `search`, which the upstream tool flags as
  unstable.
- **Reddit** — PRAW is dead for new users: Reddit closed self-service API
  registration in November 2025 (confirmed independently, not just
  assumed from a README). Use Agent Reach's `rdt-cli` backend instead —
  the only one of its two backends that doesn't require a live desktop
  Chrome session. Pinned fork commit, cookie auth, and itself unmaintained
  upstream since March 2026 — treat as more fragile than the X adapter.
- **Facebook** — still deprioritized, and Agent Reach confirms rather
  than changes this: its only backend (OpenCLI) requires a live desktop
  Chrome session and is explicitly not recommended for servers. Adapter
  interface defined, left unimplemented; manual-paste fallback in the
  admin screen instead.
- **Odds and results** — API-Football/SportMonks for fixtures+results,
  The Odds API (or equivalent) to verify claimed odds. Cache aggressively;
  these are metered.
- **Agent Reach** is pinned to a commit SHA, recorded in
  `docs/ARCHITECTURE.md` — never tracks `main`. `pip install agent-reach`
  installs an unrelated package (name collision on PyPI); the pinned
  Git install is the only correct one, also recorded there.
- Budget for a residential proxy (Webshare, ~$1/month) — both X and
  Reddit backends risk server-IP blocking.

## Docs map

- `docs/ARCHITECTURE.md` — data model, ingestion/extraction/settlement
  pipeline, adapters.
- `docs/SCORING.md` — the ROI scoring formula, confidence intervals,
  sample gates, and disqualifiers (source of truth, brief §7, verbatim).
  Slip-building rules (brief §8) and the audit module (brief §9) are
  summarized in `docs/ARCHITECTURE.md`.
- `docs/DESIGN.md` — mobile design brief: motion system, materials,
  typography, screens, anti-defaults (source of truth, brief §11).
- `docs/STATUS.md` — current state: what works, what's stubbed, what's
  blocked, task list and position, APK download/install instructions.

## Task order

One PR per task, in order. Do not run ahead of the current position
recorded in `docs/STATUS.md`.

| # | Task |
|---|---|
| 0 | Repo skeleton + `CLAUDE.md` + docs |
| 1 | Postgres schema + migrations + Telegram ingest for 3 channels, with capture-time snapshotting proven |
| 2 | Two-stage extractor (text) + fixture matching + review queue |
| 3 | Results integration + settlement rules + full test suite |
| 4 | Scoring engine — CIs, sample gates, disqualifiers |
| 5 | Slip builder + correlation guard + margin computation |
| 6 | FastAPI read API + auth |
| 7 | Expo app scaffold + APK build workflow — prove an installable APK lands as an artifact before writing any screens |
| 8 | Mobile screens per `docs/DESIGN.md` §11 |
| 9 | Reddit adapter, image extraction, audit module |
| 10 | X adapter — only if API budget is confirmed |

Task 7 comes before Task 8 deliberately: prove the build pipeline with a
one-screen app before building UI on top of it. Do not start Task 8 until
Task 4 produces real numbers from real settled data.

## Audit module (Aviator / virtuals)

Separate pipeline, separate screen, clearly labelled. Measures claimed
"signal" accounts against chance (binomial test vs. stated RTP baseline)
and reports what fraction of their calls are even verifiable. It **never**
emits a slip and the UI never renders one of its findings as an
actionable prediction. Full rules in `docs/SCORING.md`.
