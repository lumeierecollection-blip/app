"""FastAPI router for Task B4 -- manual price check. Two endpoints: one
to show the fair price for a fixture/market before the user has typed
anything, one to submit what their bookmaker actually offers and get
back the edge, stake recommendation, and a stored `manual_checks` row.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from pricing.devig import devig, fair_odds

from .service import (
    DEFAULT_KELLY_FRACTION,
    NoSharpPriceError,
    evaluate_manual_check,
    fetch_latest_sharp_quotes,
    record_manual_check,
)

router = APIRouter(prefix="/manual-check", tags=["manual-check"])


def get_connection():
    database_url = os.environ["DATABASE_URL"]
    conn = psycopg.connect(database_url)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


class FairPriceResponse(BaseModel):
    fixture_id: str
    market: str
    fair_prices: dict[str, float] = Field(description="selection -> fair odds")
    sharp_bookmaker: str = "pinnacle"


@router.get("/fair-price", response_model=FairPriceResponse)
def get_fair_price(fixture_id: str, market: str, conn: psycopg.Connection = Depends(get_connection)):
    """What the app shows the instant a fixture/market is picked, before
    any price has been typed in -- the fair line computed live from the
    sharp book, per docs/ARCHITECTURE.md's Task B4 spec."""
    quotes = fetch_latest_sharp_quotes(conn, fixture_id=fixture_id, market=market)
    if not quotes:
        raise HTTPException(status_code=404, detail=f"no sharp-book price yet for fixture {fixture_id} market {market!r}")

    sharp_odds = {q.selection: q.odds for q in quotes}
    fair_probs = devig(sharp_odds)
    fair_price_by_selection = {selection: fair_odds(prob) for selection, prob in fair_probs.items()}
    return FairPriceResponse(fixture_id=fixture_id, market=market, fair_prices=fair_price_by_selection)


class ManualCheckRequest(BaseModel):
    fixture_id: str
    market: str
    pick: str
    entered_odds: float = Field(gt=1.0)
    entered_bookmaker: str
    line: float | None = None
    kelly_fraction: float = DEFAULT_KELLY_FRACTION


class ManualCheckResponse(BaseModel):
    id: str
    fixture_id: str
    market: str
    pick: str
    line: float | None
    fair_probability: float
    fair_odds: float
    entered_odds: float
    entered_bookmaker: str
    edge: float
    stake_fraction: float | None
    passed_gates: bool
    rejections: list[str]
    checked_at: datetime


@router.post("", response_model=ManualCheckResponse)
def submit_manual_check(body: ManualCheckRequest, conn: psycopg.Connection = Depends(get_connection)):
    """The 10-seconds-before-placing-a-real-bet path: type in what your
    bookmaker offers, get the edge and a stake recommendation back, and
    have the check logged regardless of the outcome so it can be graded
    once the fixture settles."""
    try:
        result = evaluate_manual_check(
            conn,
            fixture_id=body.fixture_id,
            market=body.market,
            pick=body.pick,
            entered_odds=body.entered_odds,
            entered_bookmaker=body.entered_bookmaker,
            now=datetime.now(timezone.utc),
            line=body.line,
            kelly_fraction=body.kelly_fraction,
        )
    except NoSharpPriceError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    check_id = record_manual_check(conn, result)
    return ManualCheckResponse(
        id=check_id,
        fixture_id=result.fixture_id,
        market=result.market,
        pick=result.pick,
        line=result.line,
        fair_probability=result.fair_probability,
        fair_odds=result.fair_odds,
        entered_odds=result.entered_odds,
        entered_bookmaker=result.entered_bookmaker,
        edge=result.edge,
        stake_fraction=result.stake_fraction,
        passed_gates=result.passed_gates,
        rejections=[f"{r.gate}: {r.reason}" for r in result.rejections],
        checked_at=result.checked_at,
    )
