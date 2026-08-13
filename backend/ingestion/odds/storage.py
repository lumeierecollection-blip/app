"""Postgres writes for the odds-market ingestion path (Task B2).

`odds_snapshots` rows are never updated once written except for the
`is_closing_line` flag, set by `finalize_closing_lines` after kickoff —
see docs/ARCHITECTURE.md's append-only rule. Everything else here is
either an insert or an idempotent upsert keyed on a natural identity
(`fixtures.provider_fixture_id`).
"""

from __future__ import annotations

import psycopg

from .models import RawFixture, RawOddsQuote


def upsert_fixture(conn: psycopg.Connection, fixture: RawFixture) -> str:
    """Insert a fixture, or return the existing row's id if already known.

    ON CONFLICT DO UPDATE (not DO NOTHING) specifically so RETURNING
    always yields an id either way — callers never need a separate
    SELECT to find out what id an already-known fixture has.
    """
    row = conn.execute(
        """
        INSERT INTO fixtures (provider_fixture_id, competition, home, away, kickoff_utc)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (provider_fixture_id) DO UPDATE
            SET competition = EXCLUDED.competition
        RETURNING id
        """,
        (
            fixture.provider_fixture_id,
            fixture.competition,
            fixture.home,
            fixture.away,
            fixture.kickoff_utc,
        ),
    ).fetchone()
    assert row is not None
    return str(row[0])


def insert_odds_snapshot(conn: psycopg.Connection, fixture_id: str, quote: RawOddsQuote) -> None:
    """Always an INSERT — never call this to "correct" an earlier row."""
    conn.execute(
        """
        INSERT INTO odds_snapshots (fixture_id, bookmaker, market, selection, line, odds)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (fixture_id, quote.bookmaker, quote.market, quote.selection, quote.line, quote.odds),
    )


def finalize_closing_lines(conn: psycopg.Connection) -> int:
    """Flag the closing line for every fixture that has already kicked off.

    The closing line is the latest snapshot captured *before* kickoff,
    per (fixture, bookmaker, market, selection) — not simply "the last
    snapshot written," since a poll could in principle run late. Only
    touches fixtures whose kickoff has passed, and only rows not already
    flagged, so it's safe to call on every ingestion run without
    re-scanning or re-flagging settled fixtures.

    Returns the number of rows newly flagged.
    """
    result = conn.execute(
        """
        UPDATE odds_snapshots os
        SET is_closing_line = true
        FROM (
            SELECT DISTINCT ON (os2.fixture_id, os2.bookmaker, os2.market, os2.selection)
                os2.id
            FROM odds_snapshots os2
            JOIN fixtures f ON f.id = os2.fixture_id
            WHERE os2.captured_at < f.kickoff_utc
              AND os2.is_closing_line = false
              AND f.kickoff_utc < now()
            ORDER BY os2.fixture_id, os2.bookmaker, os2.market, os2.selection, os2.captured_at DESC
        ) latest
        WHERE os.id = latest.id
        """
    )
    return result.rowcount


def record_ingestion_health(
    conn: psycopg.Connection, *, platform: str, status: str, detail: str | None = None
) -> None:
    if status not in ("ok", "empty", "error"):
        raise ValueError(f"invalid ingestion_health status: {status!r}")
    conn.execute(
        "INSERT INTO ingestion_health (platform, status, detail) VALUES (%s, %s, %s)",
        (platform, status, detail),
    )
