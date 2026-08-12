# Status

## Current position

**Task 0 — repo skeleton + `CLAUDE.md` + docs.** Complete.

**Amendment A1 — Agent Reach ingestion research, findings written into
`docs/ARCHITECTURE.md` / `CLAUDE.md`, SHA pinned.** Complete, this PR.
This replaces the original Reddit (PRAW) and X (paid API) ingestion plan
— see `docs/ARCHITECTURE.md` § "Ingestion architecture" for the full
reasoning, including two corrections found by actually testing things
rather than trusting the source brief:

- `pip install agent-reach` installs an unrelated PyPI package (name
  collision) — the pinned Git install is the correct one, and is what's
  documented.
- Reddit's OpenCLI backend (the repo's own recommended first choice)
  needs a live desktop Chrome session and is **not viable** for a
  headless/server pipeline — only `rdt-cli` is, and it's unmaintained
  upstream since March 2026.

**Amendment A2 — `backend/ingestion/cli_runner.py`, the shared subprocess
runner every ingestion adapter will use.** Complete, this PR. Credential
redaction, env-only credential injection, timeout handling, exit-0-empty
treated as failure, and same-command retry-with-backoff, all covered by
tests that spawn real child processes rather than mocking `subprocess`.
Run with `cd backend && python3 -m pytest`.

Next up: **Task 1 — Postgres schema + migrations + Telegram ingest for 3
channels, with capture-time snapshotting proven**, then **Amendment A3**
(doctor preflight + `ingestion_health` table). A4/A5 (the actual X and
Reddit adapters) stay blocked until the resources below are in hand.

## What works

- Repo skeleton exists: `CLAUDE.md`, `docs/`, `.claude/skills/`,
  `backend/`, `mobile/`, `.github/workflows/`.
- `docs/ARCHITECTURE.md`, `docs/SCORING.md` (verbatim brief §7),
  `docs/DESIGN.md` (verbatim brief §11) are in place as the persistent
  reference for every later session.
- `.claude/skills/apple-design/SKILL.md` and
  `.claude/skills/pick-ui-library/SKILL.md` are installed and will be
  auto-discovered by Claude Code.
- Agent Reach's real `doctor --json` schema and correct pinned-install
  command are verified (not guessed) and recorded in
  `docs/ARCHITECTURE.md`.

## What's stubbed

- `mobile/` is still an empty directory — no code yet (Task 7/8).
- `backend/` has only `ingestion/cli_runner.py` so far (Amendment A2).
  No models, no API, no other adapters yet.

## What's blocked

- Nothing is blocked for Task 1 or Amendment Task A2 (the subprocess
  runner is pure Python + mocked-subprocess tests, no live credentials
  needed). Task 1 needs, before or during that session:
  - A Postgres instance (Supabase or Neon) and its connection string.
  - Telegram `api_id` / `api_hash` from my.telegram.org, and a decision
    on where the persistent session-file volume lives (Fly.io vs.
    Railway) — brief leaves this open.
  - The 3 Telegram channels to ingest from for the first proof.
- Amendment tasks A4 (X adapter) and A5 (Reddit adapter) are blocked on
  real-world decisions that need the user, not just code:
  - **A burner Twitter/X account** and its Cookie-Editor-exported
    `TWITTER_AUTH_TOKEN` / `TWITTER_CT0`, stored as GitHub secrets. Not
    the user's real account — ban risk is real.
  - **A Reddit account** with a manually-authored `rdt-cli` cookie
    (`reddit_session`), same ban-risk caveat.
  - **A residential proxy** (Webshare suggested, ~$1/month) — budget
    approval needed before wiring it in.
- Not yet needed but will block later tasks:
  - Anthropic API key for extraction (Task 2).
  - API-Football/SportMonks key and The Odds API key for
    fixtures/results/odds (Task 3).
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
- Task 1 (Telegram/Postgres) and Amendment Task A2 (`cli_runner.py`) can
  both proceed without new external decisions. Do not start feature code
  for A4/A5 (the X/Reddit adapters) until the burner accounts, cookies,
  and proxy budget above are actually in hand — those tasks need real
  secrets to build and test against, not just code.
- No dependencies have been added yet beyond what's implied by the stack
  table in `CLAUDE.md` — anything else needs to be asked about first.
  Agent Reach is the one addition from the amendment; it's pinned to a
  SHA in `docs/ARCHITECTURE.md`, not tracked on `main`.
