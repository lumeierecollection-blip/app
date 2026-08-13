"""Integration test for backend/settlement/sweep.py against real local
Postgres: a fixture that kicked off well over 150 minutes ago, a pending
selection, a real result payload, and a check that the stored settlement
matches the pure rule function's answer.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from db import migrate
from settlement.rules import RULE_VERSION
from settlement.sweep import find_pending_selections, settle_selections_with_results

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


def _insert_fixture_and_selection(conn, *, provider_fixture_id, kickoff, market="moneyline", pick="home", line=None):
    fixture_row = conn.execute(
        """
        INSERT INTO fixtures (provider_fixture_id, competition, home, away, kickoff_utc)
        VALUES (%s, 'Premier League', 'Home FC', 'Away FC', %s)
        RETURNING id
        """,
        (provider_fixture_id, kickoff),
    ).fetchone()
    fixture_id = str(fixture_row[0])

    selection_row = conn.execute(
        """
        INSERT INTO selections (origin, fixture_id, competition, home, away, kickoff_utc, market, pick, line, verified_odds)
        VALUES ('auto_odds', %s, 'Premier League', 'Home FC', 'Away FC', %s, %s, %s, %s, 2.0)
        RETURNING id
        """,
        (fixture_id, kickoff, market, pick, line),
    ).fetchone()
    return fixture_id, str(selection_row[0])


def test_find_pending_selections_only_returns_old_unsettled_ones(conn):
    old_kickoff = NOW - timedelta(hours=4)  # well past the 150-minute delay
    recent_kickoff = NOW - timedelta(minutes=30)  # still within the delay window

    _, old_selection_id = _insert_fixture_and_selection(conn, provider_fixture_id=1, kickoff=old_kickoff)
    _, recent_selection_id = _insert_fixture_and_selection(conn, provider_fixture_id=2, kickoff=recent_kickoff)
    conn.commit()

    pending = find_pending_selections(conn, now=NOW)
    pending_ids = {p.id for p in pending}
    assert old_selection_id in pending_ids
    assert recent_selection_id not in pending_ids


def test_settle_selections_with_results_stores_a_real_settlement(conn):
    old_kickoff = NOW - timedelta(hours=4)
    fixture_id, selection_id = _insert_fixture_and_selection(conn, provider_fixture_id=1, kickoff=old_kickoff)
    conn.commit()

    results_by_fixture = {fixture_id: {"match_status": "FT", "goals_home": 2, "goals_away": 1}}
    settled_count = settle_selections_with_results(conn, now=NOW, results_by_fixture=results_by_fixture)
    assert settled_count == 1

    row = conn.execute(
        "SELECT status, payout_fraction, settlement_rule_version FROM settlements WHERE selection_id = %s",
        (selection_id,),
    ).fetchone()
    assert row is not None
    status, payout_fraction, rule_version = row
    assert status == "won"  # home pick, home won 2-1
    assert float(payout_fraction) == pytest.approx(1.0)
    assert rule_version == RULE_VERSION


def test_settle_selections_with_results_leaves_selections_without_a_result_pending(conn):
    old_kickoff = NOW - timedelta(hours=4)
    fixture_id, selection_id = _insert_fixture_and_selection(conn, provider_fixture_id=1, kickoff=old_kickoff)
    conn.commit()

    settled_count = settle_selections_with_results(conn, now=NOW, results_by_fixture={})
    assert settled_count == 0

    row = conn.execute("SELECT status FROM settlements WHERE selection_id = %s", (selection_id,)).fetchone()
    assert row is None  # still pending, not guessed as ungradeable

    pending = find_pending_selections(conn, now=NOW)
    assert any(p.id == selection_id for p in pending)


def test_settle_selections_with_results_records_ungradeable_for_unhandled_market(conn):
    old_kickoff = NOW - timedelta(hours=4)
    fixture_id, selection_id = _insert_fixture_and_selection(
        conn, provider_fixture_id=1, kickoff=old_kickoff, market="correct_score", pick="2-1"
    )
    conn.commit()

    results_by_fixture = {fixture_id: {"match_status": "FT", "goals_home": 2, "goals_away": 1}}
    settled_count = settle_selections_with_results(conn, now=NOW, results_by_fixture=results_by_fixture)
    assert settled_count == 1

    row = conn.execute("SELECT status FROM settlements WHERE selection_id = %s", (selection_id,)).fetchone()
    assert row[0] == "ungradeable"


def test_settle_selections_with_results_is_safe_to_rerun(conn):
    old_kickoff = NOW - timedelta(hours=4)
    fixture_id, selection_id = _insert_fixture_and_selection(conn, provider_fixture_id=1, kickoff=old_kickoff)
    conn.commit()

    results_by_fixture = {fixture_id: {"match_status": "FT", "goals_home": 2, "goals_away": 1}}
    first = settle_selections_with_results(conn, now=NOW, results_by_fixture=results_by_fixture)
    second = settle_selections_with_results(conn, now=NOW, results_by_fixture=results_by_fixture)
    assert first == 1
    assert second == 0  # already settled, not re-settled or duplicated

    count = conn.execute(
        "SELECT count(*) FROM settlements WHERE selection_id = %s", (selection_id,)
    ).fetchone()[0]
    assert count == 1
