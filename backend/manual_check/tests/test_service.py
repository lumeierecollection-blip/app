"""Tests for backend/manual_check/service.py against real local Postgres
(same per-test isolated-schema pattern as backend/ingestion/odds/tests/
test_run_once.py)."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from db import migrate
from manual_check.service import (
    NoSharpPriceError,
    evaluate_manual_check,
    fetch_latest_sharp_quotes,
    kelly_stake_fraction,
    record_manual_check,
)

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")

NOW = datetime(2026, 8, 13, 12, 0, 0, tzinfo=timezone.utc)


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


@pytest.fixture
def fixture_id(conn):
    row = conn.execute(
        """
        INSERT INTO fixtures (provider_fixture_id, competition, home, away, kickoff_utc)
        VALUES (900001, 'Premier League', 'Arsenal', 'Chelsea', %s)
        RETURNING id
        """,
        (NOW + timedelta(days=3),),
    ).fetchone()
    return str(row[0])


def insert_pinnacle_1x2(conn, fixture_id, captured_at=None):
    captured_at = captured_at or (NOW - timedelta(minutes=1))
    for selection, odds in (("home", 1.165), ("draw", 7.66), ("away", 15.44)):
        conn.execute(
            """
            INSERT INTO odds_snapshots (fixture_id, bookmaker, market, selection, odds, captured_at)
            VALUES (%s, 'pinnacle', 'moneyline', %s, %s, %s)
            """,
            (fixture_id, selection, odds, captured_at),
        )


def test_kelly_stake_fraction_no_edge_is_none():
    assert kelly_stake_fraction(edge=0.0, offered_odds=2.0) is None
    assert kelly_stake_fraction(edge=-0.05, offered_odds=2.0) is None


def test_kelly_stake_fraction_positive_edge_is_quarter_kelly_capped():
    # edge=0.10, offered=2.0 -> net_odds=1.0, full kelly = 0.10/1.0 = 0.10
    # quarter kelly = 0.025, under the 0.05 cap.
    frac = kelly_stake_fraction(edge=0.10, offered_odds=2.0)
    assert frac == pytest.approx(0.025)


def test_kelly_stake_fraction_respects_hard_cap():
    # A huge edge should still be capped at MAX_STAKE_FRACTION.
    frac = kelly_stake_fraction(edge=0.9, offered_odds=1.5, kelly_fraction=1.0)
    assert frac == pytest.approx(0.05)


def test_fetch_latest_sharp_quotes_returns_latest_per_selection(conn, fixture_id):
    insert_pinnacle_1x2(conn, fixture_id, captured_at=NOW - timedelta(hours=1))
    insert_pinnacle_1x2(conn, fixture_id, captured_at=NOW - timedelta(minutes=1))  # newer snapshot

    quotes = fetch_latest_sharp_quotes(conn, fixture_id=fixture_id, market="moneyline")
    assert len(quotes) == 3
    by_selection = {q.selection: q for q in quotes}
    assert by_selection["home"].captured_at == NOW - timedelta(minutes=1)


def test_evaluate_manual_check_finds_a_real_edge(conn, fixture_id):
    insert_pinnacle_1x2(conn, fixture_id)
    result = evaluate_manual_check(
        conn,
        fixture_id=fixture_id,
        market="moneyline",
        pick="home",
        entered_odds=1.30,  # meaningfully better than fair ~1.185
        entered_bookmaker="local-book",
        now=NOW,
    )
    assert result.passed_gates is True
    assert result.edge > 0.02
    assert result.stake_fraction is not None
    assert result.stake_fraction > 0


def test_evaluate_manual_check_raises_without_any_sharp_price(conn, fixture_id):
    with pytest.raises(NoSharpPriceError):
        evaluate_manual_check(
            conn,
            fixture_id=fixture_id,
            market="moneyline",
            pick="home",
            entered_odds=1.30,
            entered_bookmaker="local-book",
            now=NOW,
        )


def test_evaluate_manual_check_unknown_pick_raises(conn, fixture_id):
    insert_pinnacle_1x2(conn, fixture_id)
    with pytest.raises(ValueError):
        evaluate_manual_check(
            conn,
            fixture_id=fixture_id,
            market="moneyline",
            pick="not_a_real_selection",
            entered_odds=1.30,
            entered_bookmaker="local-book",
            now=NOW,
        )


def test_record_manual_check_stores_regardless_of_gate_outcome(conn, fixture_id):
    insert_pinnacle_1x2(conn, fixture_id, captured_at=NOW - timedelta(minutes=30))  # stale -> gate fails
    result = evaluate_manual_check(
        conn,
        fixture_id=fixture_id,
        market="moneyline",
        pick="home",
        entered_odds=1.30,
        entered_bookmaker="local-book",
        now=NOW,
    )
    assert result.passed_gates is False
    assert result.stake_fraction is None  # never recommend a stake on a rejected check

    check_id = record_manual_check(conn, result)
    row = conn.execute("SELECT entered_bookmaker, edge FROM manual_checks WHERE id = %s", (check_id,)).fetchone()
    assert row is not None
    assert row[0] == "local-book"
