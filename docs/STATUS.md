# Status

## Current position

**Task 0 — repo skeleton + `CLAUDE.md` + docs.** Complete, this PR.

Next up: **Task 1 — Postgres schema + migrations + Telegram ingest for 3
channels, with capture-time snapshotting proven.**

## What works

- Repo skeleton exists: `CLAUDE.md`, `docs/`, `.claude/skills/`,
  `backend/`, `mobile/`, `.github/workflows/`.
- `docs/ARCHITECTURE.md`, `docs/SCORING.md` (verbatim brief §7),
  `docs/DESIGN.md` (verbatim brief §11) are in place as the persistent
  reference for every later session.
- `.claude/skills/apple-design/SKILL.md` and
  `.claude/skills/pick-ui-library/SKILL.md` are installed and will be
  auto-discovered by Claude Code.

## What's stubbed

- Everything. `backend/` and `mobile/` are empty directories — no code
  yet. This task deliberately ships no feature code.

## What's blocked

- Nothing is blocked yet. Task 1 needs, before or during that session:
  - A Postgres instance (Supabase or Neon) and its connection string.
  - Telegram `api_id` / `api_hash` from my.telegram.org, and a decision
    on where the persistent session-file volume lives (Fly.io vs.
    Railway) — brief leaves this open.
  - The 3 Telegram channels to ingest from for the first proof.
- Not yet needed but will block later tasks:
  - Anthropic API key for extraction (Task 2).
  - API-Football/SportMonks key and The Odds API key for
    fixtures/results/odds (Task 3).
  - Reddit script-app credentials (Task 9).
  - Confirmed X API budget, or the decision to skip Task 10 entirely.
  - `ANDROID_KEYSTORE_BASE64` + password/alias secrets for signed APK
    builds (Task 7) — generate and store as GitHub secrets when that
    task starts; never commit the keystore.
  - `EXPO_PUBLIC_API_URL` for the mobile build once the API (Task 6) has
    a real host.

## How to download and install the APK

Not applicable yet — the build workflow doesn't exist until Task 7. This
section will be filled in with exact steps (download from the Actions
run artifact, enable "install from unknown sources" once, install) when
that task lands.

## Notes for the next session

- Read `CLAUDE.md` first, then `docs/ARCHITECTURE.md`, `docs/SCORING.md`,
  `docs/DESIGN.md`, then this file, before writing any code.
- Task 1 is next. Do not start Task 2 work in the same PR.
- No dependencies have been added yet beyond what's implied by the stack
  table in `CLAUDE.md` — anything else needs to be asked about first.
