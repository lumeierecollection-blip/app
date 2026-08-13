"""Task B4 -- manual price check: the primary way this system gets used
against a bookmaker not covered by the odds API (docs/ARCHITECTURE.md §
"Manual price check"). Pick a fixture/market, see the fair price computed
from the sharp (Pinnacle) line, type in what your own bookmaker actually
offers, get back the edge and a stake-fraction recommendation. Every
check is logged in `manual_checks` regardless of outcome -- this table is
a source of real, scoreable strategies, not a scratchpad.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import psycopg

from pricing.edge import DEFAULT_EDGE_THRESHOLD, EdgeEvaluation, GateRejection, evaluate_edge

SHARP_BOOKMAKER = "pinnacle"

# Quarter-Kelly, not full Kelly: full Kelly stakes assume the edge
# estimate is exact, but a de-vigged market price is a best estimate, not
# a certainty, and full Kelly is punishing when that estimate is wrong.
# Quarter-Kelly is a common practical compromise -- most of the growth,
# a fraction of the variance -- and is a setting, not a hardcoded
# constant, same as the edge threshold in Task B3.
DEFAULT_KELLY_FRACTION = 0.25
MAX_STAKE_FRACTION = 0.05  # hard cap regardless of what Kelly suggests


@dataclass
class SharpQuote:
    selection: str
    line: float | None
    odds: float
    captured_at: datetime


class NoSharpPriceError(Exception):
    """Raised when there's no sharp-book quote to de-vig against at all --
    the manual-check screen has nothing to show yet for this fixture/market."""


def fetch_latest_sharp_quotes(
    conn: psycopg.Connection, *, fixture_id: str, market: str, bookmaker: str = SHARP_BOOKMAKER
) -> list[SharpQuote]:
    """The latest snapshot per selection for this fixture/market/bookmaker
    -- same DISTINCT ON pattern as finalize_closing_lines in
    backend/ingestion/odds/storage.py, applied to "latest" instead of
    "latest before kickoff"."""
    rows = conn.execute(
        """
        SELECT DISTINCT ON (selection) selection, line, odds, captured_at
        FROM odds_snapshots
        WHERE fixture_id = %s AND bookmaker = %s AND market = %s
        ORDER BY selection, captured_at DESC
        """,
        (fixture_id, bookmaker, market),
    ).fetchall()
    return [SharpQuote(selection=r[0], line=r[1], odds=float(r[2]), captured_at=r[3]) for r in rows]


def kelly_stake_fraction(
    edge: float, offered_odds: float, kelly_fraction: float = DEFAULT_KELLY_FRACTION
) -> float | None:
    """Fractional-Kelly stake as a share of bankroll. None (not zero) when
    there's no positive edge -- "no bet" is a different fact from "bet
    0%", and callers should treat them differently."""
    if edge <= 0:
        return None
    net_odds = offered_odds - 1.0
    full_kelly = edge / net_odds
    return min(full_kelly * kelly_fraction, MAX_STAKE_FRACTION)


@dataclass
class ManualCheckResult:
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
    rejections: list[GateRejection]
    checked_at: datetime
    id: str | None = None


def evaluate_manual_check(
    conn: psycopg.Connection,
    *,
    fixture_id: str,
    market: str,
    pick: str,
    entered_odds: float,
    entered_bookmaker: str,
    now: datetime | None = None,
    line: float | None = None,
    edge_threshold: float = DEFAULT_EDGE_THRESHOLD,
    kelly_fraction: float = DEFAULT_KELLY_FRACTION,
) -> ManualCheckResult:
    """Compute the fair price from the real sharp-book line, then the edge
    and stake recommendation for what the user actually typed in. Does
    not store anything -- see `record_manual_check` for that, kept
    separate so the app can show the fair price live as the user picks a
    market, before they've typed an offered price at all."""
    now = now or datetime.now(timezone.utc)
    quotes = fetch_latest_sharp_quotes(conn, fixture_id=fixture_id, market=market)
    if not quotes:
        raise NoSharpPriceError(f"no sharp-book quotes for fixture {fixture_id} market {market!r}")

    sharp_odds = {q.selection: q.odds for q in quotes}
    if pick not in sharp_odds:
        raise ValueError(f"pick {pick!r} not among sharp-book selections {list(sharp_odds)}")

    by_selection = {q.selection: q for q in quotes}
    sharp_captured_at = by_selection[pick].captured_at
    sharp_line = by_selection[pick].line

    evaluation: EdgeEvaluation = evaluate_edge(
        sharp_odds=sharp_odds,
        selection=pick,
        offered_odds=entered_odds,
        now=now,
        sharp_captured_at=sharp_captured_at,
        sharp_line=sharp_line,
        soft_line=line,
        edge_threshold=edge_threshold,
    )

    stake_fraction = None
    if evaluation.passed_gates:
        stake_fraction = kelly_stake_fraction(evaluation.edge, entered_odds, kelly_fraction)

    return ManualCheckResult(
        fixture_id=fixture_id,
        market=market,
        pick=pick,
        line=line,
        fair_probability=evaluation.fair_probability,
        fair_odds=evaluation.fair_odds,
        entered_odds=entered_odds,
        entered_bookmaker=entered_bookmaker,
        edge=evaluation.edge,
        stake_fraction=stake_fraction,
        passed_gates=evaluation.passed_gates,
        rejections=evaluation.rejections,
        checked_at=now,
    )


def record_manual_check(conn: psycopg.Connection, result: ManualCheckResult) -> str:
    """Store the check -- regardless of whether it passed the sanity
    gates or found a real edge. docs/ARCHITECTURE.md is explicit that
    this table isn't a scratchpad: every check gets logged so it can be
    graded once the fixture settles."""
    row = conn.execute(
        """
        INSERT INTO manual_checks (
            fixture_id, market, pick, line, fair_probability, fair_odds,
            entered_odds, entered_bookmaker, edge, stake_fraction, checked_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            result.fixture_id,
            result.market,
            result.pick,
            result.line,
            result.fair_probability,
            result.fair_odds,
            result.entered_odds,
            result.entered_bookmaker,
            result.edge,
            result.stake_fraction,
            result.checked_at,
        ),
    ).fetchone()
    assert row is not None
    return str(row[0])
