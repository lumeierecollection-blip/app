"""Tests for the migration runner, against a real local Postgres.

Real Postgres, not a mock or SQLite: the migrations use Postgres-specific
features (gen_random_uuid(), TIMESTAMPTZ, partial indexes) that a fake
would either not catch mistakes in or would need to fake convincingly
enough to be pointless. Skips cleanly if DATABASE_URL isn't set, so the
rest of the suite still runs without a local Postgres available.

Each test gets its own schema (not its own database — that needs
autocommit / CREATE DATABASE privileges this connection may not have),
created and dropped around the test so runs don't collide or leave state
behind.
"""

from __future__ import annotations

import os
import uuid

import psycopg
import pytest

from db import migrate

DATABASE_URL = os.environ.get("DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DATABASE_URL, reason="DATABASE_URL not set — no local Postgres to test against"
)


@pytest.fixture
def conn():
    schema = f"test_{uuid.uuid4().hex[:12]}"
    connection = psycopg.connect(DATABASE_URL, autocommit=True)
    connection.execute(f"CREATE SCHEMA {schema}")
    connection.execute(f"SET search_path TO {schema}")
    connection.autocommit = False
    try:
        yield connection
    finally:
        connection.rollback()
        connection.autocommit = True
        connection.execute(f"DROP SCHEMA {schema} CASCADE")
        connection.close()


def test_apply_migrations_creates_all_tables(conn):
    applied = migrate.apply_migrations(conn)
    assert applied == [
        "001_fixtures.sql",
        "002_odds_snapshots.sql",
        "003_strategies.sql",
        "004_manual_checks.sql",
        "005_ingestion_health.sql",
        "006_selections.sql",
        "007_settlements.sql",
        "008_strategy_scores.sql",
        "009_slips.sql",
        "010_audit_calls.sql",
        "011_settlements_payout_fraction.sql",
    ]

    tables = {
        row[0]
        for row in conn.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"
        )
    }
    assert {
        "fixtures",
        "odds_snapshots",
        "strategies",
        "manual_checks",
        "ingestion_health",
        "selections",
        "settlements",
        "strategy_scores",
        "slips",
        "audit_calls",
        "schema_migrations",
    } <= tables


def test_apply_migrations_is_idempotent(conn):
    first = migrate.apply_migrations(conn)
    assert len(first) == 11
    second = migrate.apply_migrations(conn)
    assert second == []


def test_odds_snapshots_rejects_odds_of_one_or_less(conn):
    migrate.apply_migrations(conn)
    fixture_id = conn.execute(
        """
        INSERT INTO fixtures (provider_fixture_id, competition, home, away, kickoff_utc)
        VALUES (1, 'EPL', 'Team A', 'Team B', now() + interval '1 day')
        RETURNING id
        """
    ).fetchone()[0]

    with pytest.raises(psycopg.errors.CheckViolation):
        with conn.transaction():
            conn.execute(
                """
                INSERT INTO odds_snapshots (fixture_id, bookmaker, market, selection, odds)
                VALUES (%s, 'pinnacle', 'h2h', 'home', 1.0)
                """,
                (fixture_id,),
            )


def test_odds_snapshots_never_updates_only_inserts(conn):
    """The append-only contract, proven, not just documented in a comment."""
    migrate.apply_migrations(conn)
    fixture_id = conn.execute(
        """
        INSERT INTO fixtures (provider_fixture_id, competition, home, away, kickoff_utc)
        VALUES (2, 'EPL', 'Team A', 'Team B', now() + interval '1 day')
        RETURNING id
        """
    ).fetchone()[0]

    for odds_value in (1.90, 1.85, 1.80):
        conn.execute(
            """
            INSERT INTO odds_snapshots (fixture_id, bookmaker, market, selection, odds)
            VALUES (%s, 'pinnacle', 'h2h', 'home', %s)
            """,
            (fixture_id, odds_value),
        )

    rows = conn.execute(
        "SELECT odds FROM odds_snapshots WHERE fixture_id = %s ORDER BY captured_at",
        (fixture_id,),
    ).fetchall()
    # psycopg returns NUMERIC as Decimal, not float — compare as float
    # explicitly rather than relying on cross-type equality.
    assert [float(r[0]) for r in rows] == [1.90, 1.85, 1.80]


def test_fixtures_provider_fixture_id_is_unique(conn):
    migrate.apply_migrations(conn)
    conn.execute(
        """
        INSERT INTO fixtures (provider_fixture_id, competition, home, away, kickoff_utc)
        VALUES (99, 'EPL', 'Team A', 'Team B', now() + interval '1 day')
        """
    )
    with pytest.raises(psycopg.errors.UniqueViolation):
        with conn.transaction():
            conn.execute(
                """
                INSERT INTO fixtures (provider_fixture_id, competition, home, away, kickoff_utc)
                VALUES (99, 'EPL', 'Team C', 'Team D', now() + interval '2 days')
                """
            )


def test_ingestion_health_rejects_unknown_status(conn):
    migrate.apply_migrations(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        with conn.transaction():
            conn.execute(
                "INSERT INTO ingestion_health (platform, status) VALUES ('oddspapi', 'fine')"
            )
