"""Tests for odds-market storage functions, against real local Postgres.

Real Postgres, not a mock: finalize_closing_lines is a nontrivial SQL
query (DISTINCT ON + a correlated subquery), and the whole point of
testing it is proving the query itself is correct, which a mock can't do.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from db import migrate
from ingestion.odds.models import RawFixture, RawOddsQuote
from ingestion.odds.storage import (
    finalize_closing_lines,
    insert_odds_snapshot,
    record_ingestion_health,
    upsert_fixture,
)

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")

NOW = datetime.now(timezone.utc)


@pytest.fixture
def conn():
    schema = f"test_{uuid.uuid4().hex[:12]}"
    connection = psycopg.connect(DATABASE_URL, autocommit=True)
    connection.execute(f"CREATE SCHEMA {schema}")
    connection.execute(f"SET search_path TO {schema}")
    connection.autocommit = False
    migrate.apply_migrations(connection)
    connection.commit()
    try:
        yield connection
    finally:
        connection.rollback()
        connection.autocommit = True
        connection.execute(f"DROP SCHEMA {schema} CASCADE")
        connection.close()


def _quote(**overrides):
    defaults = dict(
        provider_fixture_id=1,
        home="Arsenal",
        away="Chelsea",
        kickoff_utc=NOW + timedelta(hours=1),
        bookmaker="pinnacle",
        market="h2h",
        selection="home",
        line=None,
        odds=1.9,
    )
    defaults.update(overrides)
    return RawOddsQuote(**defaults)


def test_upsert_fixture_is_idempotent_on_provider_fixture_id(conn):
    fixture = RawFixture(
        provider_fixture_id=42, competition="EPL",
        home="Arsenal", away="Chelsea", kickoff_utc=NOW + timedelta(days=1),
    )
    id1 = upsert_fixture(conn, fixture)
    id2 = upsert_fixture(conn, fixture)
    assert id1 == id2

    count = conn.execute("SELECT count(*) FROM fixtures").fetchone()[0]
    assert count == 1


def test_insert_odds_snapshot_never_overwrites(conn):
    fixture = RawFixture(
        provider_fixture_id=1, competition="EPL",
        home="Arsenal", away="Chelsea", kickoff_utc=NOW + timedelta(hours=1),
    )
    fixture_id = upsert_fixture(conn, fixture)

    insert_odds_snapshot(conn, fixture_id, _quote(odds=1.90))
    insert_odds_snapshot(conn, fixture_id, _quote(odds=1.85))

    rows = conn.execute(
        "SELECT odds FROM odds_snapshots WHERE fixture_id = %s ORDER BY captured_at", (fixture_id,)
    ).fetchall()
    assert [float(r[0]) for r in rows] == [1.90, 1.85]


def test_finalize_closing_lines_flags_only_the_latest_pre_kickoff_snapshot(conn):
    past_kickoff = NOW - timedelta(hours=3)
    fixture = RawFixture(
        provider_fixture_id=1, competition="EPL",
        home="Arsenal", away="Chelsea", kickoff_utc=past_kickoff,
    )
    fixture_id = upsert_fixture(conn, fixture)

    # Three pre-kickoff snapshots, inserted with explicit captured_at so
    # ordering is deterministic regardless of how fast the test runs.
    for odds, offset in [(2.10, timedelta(hours=5)), (1.95, timedelta(hours=4)), (1.90, timedelta(hours=3, minutes=10))]:
        conn.execute(
            """
            INSERT INTO odds_snapshots (fixture_id, bookmaker, market, selection, odds, captured_at)
            VALUES (%s, 'pinnacle', 'h2h', 'home', %s, %s)
            """,
            (fixture_id, odds, past_kickoff - offset),
        )

    flagged = finalize_closing_lines(conn)
    assert flagged == 1

    closing = conn.execute(
        "SELECT odds FROM odds_snapshots WHERE fixture_id = %s AND is_closing_line = true", (fixture_id,)
    ).fetchall()
    assert len(closing) == 1
    assert float(closing[0][0]) == 1.90  # the latest one before kickoff


def test_finalize_closing_lines_ignores_fixtures_that_have_not_kicked_off_yet(conn):
    fixture = RawFixture(
        provider_fixture_id=1, competition="EPL",
        home="Arsenal", away="Chelsea", kickoff_utc=NOW + timedelta(hours=2),
    )
    fixture_id = upsert_fixture(conn, fixture)
    insert_odds_snapshot(conn, fixture_id, _quote(odds=1.9, kickoff_utc=NOW + timedelta(hours=2)))

    flagged = finalize_closing_lines(conn)
    assert flagged == 0


def test_finalize_closing_lines_is_idempotent(conn):
    # insert_odds_snapshot always stamps captured_at = now() (correctly --
    # it's "when we polled," not a property of the quote) — so a
    # pre-kickoff snapshot has to be inserted with an explicit past
    # captured_at via raw SQL, the same way test_finalize_closing_lines_
    # flags_only_the_latest_pre_kickoff_snapshot above does. Passing
    # kickoff_utc into _quote() here has no effect on storage; it only
    # affects what a live-parsed RawOddsQuote *would* have carried.
    past_kickoff = NOW - timedelta(hours=1)
    fixture = RawFixture(
        provider_fixture_id=1, competition="EPL",
        home="Arsenal", away="Chelsea", kickoff_utc=past_kickoff,
    )
    fixture_id = upsert_fixture(conn, fixture)
    conn.execute(
        """
        INSERT INTO odds_snapshots (fixture_id, bookmaker, market, selection, odds, captured_at)
        VALUES (%s, 'pinnacle', 'h2h', 'home', 1.9, %s)
        """,
        (fixture_id, past_kickoff - timedelta(minutes=10)),
    )

    first = finalize_closing_lines(conn)
    second = finalize_closing_lines(conn)
    assert first == 1
    assert second == 0


def test_finalize_closing_lines_handles_multiple_markets_independently(conn):
    """h2h and totals for the same fixture must each get their own
    closing-line flag -- one market's data must not affect another's."""
    past_kickoff = NOW - timedelta(hours=1)
    fixture = RawFixture(
        provider_fixture_id=1, competition="EPL",
        home="Arsenal", away="Chelsea", kickoff_utc=past_kickoff,
    )
    fixture_id = upsert_fixture(conn, fixture)
    for market, selection, odds in [("h2h", "home", 1.9), ("totals", "over", 1.95)]:
        conn.execute(
            """
            INSERT INTO odds_snapshots (fixture_id, bookmaker, market, selection, line, odds, captured_at)
            VALUES (%s, 'pinnacle', %s, %s, 2.5, %s, %s)
            """,
            (fixture_id, market, selection, odds, past_kickoff - timedelta(minutes=10)),
        )

    flagged = finalize_closing_lines(conn)
    assert flagged == 2

    markets = {
        row[0]
        for row in conn.execute(
            "SELECT market FROM odds_snapshots WHERE fixture_id = %s AND is_closing_line = true", (fixture_id,)
        ).fetchall()
    }
    assert markets == {"h2h", "totals"}


def test_record_ingestion_health_rejects_invalid_status(conn):
    with pytest.raises(ValueError, match="invalid ingestion_health status"):
        record_ingestion_health(conn, platform="oddspapi", status="fine")


def test_record_ingestion_health_writes_a_row(conn):
    record_ingestion_health(conn, platform="oddspapi", status="error", detail="429 rate limited")
    row = conn.execute("SELECT platform, status, detail FROM ingestion_health").fetchone()
    assert row == ("oddspapi", "error", "429 rate limited")
