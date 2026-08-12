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
interface — there is deliberately no single generic scraper.

### Telegram — primary source, built first
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

### Reddit — official API
- **PRAW** with a registered script app.
- Poll target subreddits' `/new` and `/user/<name>/submitted` every
  3–5 minutes.
- Capture the `edited` field. A tip edited after kickoff is disqualified.

### X — API only, and it costs money
- The free tier is read-crippled; useful timeline reads need Basic tier.
- Do not build a headless-browser scraper — it violates ToS and
  anti-automation systems will kill the account and IP.
- Behind the `SourceAdapter` interface so it can be switched off. If the
  budget isn't confirmed, ship without X — Telegram plus Reddit covers
  most volume.

### Facebook — deprioritized
- No usable public read API for arbitrary Pages/Groups; scraping is
  against ToS and heavily defended.
- Adapter interface defined, left unimplemented. Manual-paste fallback
  in the admin screen instead. Do not spend session time on bot
  detection.

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
