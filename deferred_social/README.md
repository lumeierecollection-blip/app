# Deferred social-path infrastructure

`cli_runner.py` is Amendment A2's shared subprocess runner for the
deferred social/tipster path (Agent Reach's `twitter-cli`/`rdt-cli`
backends), kept per `CLAUDE.md`'s "stays in the repo as reusable infra"
note — unrelated to the backend rewrite in Prompt 8 (Amendment D).

**Moved here from `backend/ingestion/cli_runner.py`** when `backend/`
was retired from Python/FastAPI to plain Node.js (Amendment D) and
removed wholesale with `git rm -r backend`. That removal was too broad —
Prompt 8 only asked to replace the FastAPI/Postgres/odds-ingestion stack,
not this deferred-path file — caught and fixed in the same session by
recovering it from git history rather than leaving it silently gone.

Still Python, deliberately: this wraps subprocess management for
Python-based CLI tools (Agent Reach), independent of whatever language
the primary backend is written in.

Run its tests (needs `pytest`, not part of the Node backend's toolchain):

```bash
pip install pytest
cd deferred_social && python3 -m pytest
```

Unused while `sources.social.enabled` is off. No urgency to touch this
until Amendment A3+ resumes.
