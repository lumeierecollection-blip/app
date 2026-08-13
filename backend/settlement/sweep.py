"""Task B6 -- the settlement sweep: find selections whose fixture kicked
off long enough ago to have a final result and no settlement row yet,
settle them with the pure rule functions in rules.py, and store the
result with the rule version that produced it.

Real result data (final scores) isn't sourced by anything in this
repo yet -- no confirmed API-Football endpoint/shape for finished-match
scores exists (see rules.py's module docstring). `results_by_fixture` is
therefore an explicit parameter here rather than something this module
fetches itself: whatever ingestion eventually pulls real results is a
separate, later piece of work, and this module is ready to consume it
the moment it exists.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import psycopg

from .rules import RULE_VERSION, settle_selection

SETTLEMENT_DELAY = timedelta(minutes=150)


@dataclass
class PendingSelection:
    id: str
    fixture_id: str
    market: str
    pick: str
    line: float | None


def find_pending_selections(conn: psycopg.Connection, *, now: datetime) -> list[PendingSelection]:
    """Selections whose fixture kicked off more than 150 minutes ago and
    have no settlement row yet -- the sweep window from
    docs/ARCHITECTURE.md § "Settlement"."""
    rows = conn.execute(
        """
        SELECT sel.id, sel.fixture_id, sel.market, sel.pick, sel.line
        FROM selections sel
        JOIN fixtures f ON f.id = sel.fixture_id
        LEFT JOIN settlements st ON st.selection_id = sel.id
        WHERE st.selection_id IS NULL
          AND f.kickoff_utc + %s < %s
        """,
        (SETTLEMENT_DELAY, now),
    ).fetchall()
    return [
        PendingSelection(id=str(r[0]), fixture_id=str(r[1]), market=r[2], pick=r[3], line=r[4]) for r in rows
    ]


def record_settlement(
    conn: psycopg.Connection,
    *,
    selection_id: str,
    status: str,
    payout_fraction: float,
    result_payload: dict[str, Any] | None,
    settled_at: datetime,
    rule_version: str = RULE_VERSION,
) -> None:
    conn.execute(
        """
        INSERT INTO settlements (selection_id, status, payout_fraction, settled_at, result_payload, settlement_rule_version)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (selection_id, status, payout_fraction, settled_at, psycopg.types.json.Json(result_payload), rule_version),
    )


def settle_selections_with_results(
    conn: psycopg.Connection,
    *,
    now: datetime,
    results_by_fixture: dict[str, dict[str, Any]],
) -> int:
    """Settle every pending selection whose fixture has a result in
    `results_by_fixture`. Selections for fixtures with no result yet are
    left pending -- not settled as `ungradeable` -- since "no result yet"
    and "unhandled market/data" are different facts, same distinction
    ingestion_health already draws between 'empty' and 'error'.

    Returns the number of selections settled (any status, including
    ungradeable, void, and push -- all of those are still a settlement
    decision, unlike "no result available yet")."""
    pending = find_pending_selections(conn, now=now)
    settled_count = 0
    for selection in pending:
        result_payload = results_by_fixture.get(selection.fixture_id)
        if result_payload is None:
            continue
        outcome = settle_selection(selection, result_payload)
        record_settlement(
            conn,
            selection_id=selection.id,
            status=outcome.status,
            payout_fraction=outcome.payout_fraction,
            result_payload=result_payload,
            settled_at=now,
        )
        settled_count += 1
    return settled_count
