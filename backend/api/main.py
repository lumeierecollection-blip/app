"""FastAPI app entrypoint. Run with:

    uvicorn api.main:app --host 0.0.0.0 --port 8000

from the backend/ directory, with DATABASE_URL set. This is what the
Flutter app (Task B7) talks to.
"""

from __future__ import annotations

from fastapi import FastAPI

from manual_check.api import router as manual_check_router

app = FastAPI(title="Tipster Aggregator API")
app.include_router(manual_check_router)


@app.get("/health")
def health():
    return {"status": "ok"}
