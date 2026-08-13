"""Integration test for Task B5 against real local Postgres: a strategy
with 50 real settled selections, closing lines, and one manual check --
proving load -> score -> upsert end to end, not just the pure math."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from db import migrate
from scoring.run import score_all_strategies

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


def _make_fixture(conn, n):
    kickoff = NOW - timedelta(days=60 - n)
    row = conn.execute(
        """
        INSERT INTO fixtures (provider_fixture_id, competition, home, away, kickoff_utc)
        VALUES (%s, 'Premier League', 'Home FC', 'Away FC', %s)
        RETURNING id
        """,
        (900000 + n, kickoff),
    ).fetchone()
    return str(row[0])


def test_score_all_strategies_end_to_end(conn):
    strategy_row = conn.execute(
        """
        INSERT INTO strategies (competition, market_class, edge_threshold, source_book)
        VALUES ('Premier League', 'moneyline', 0.02, 'local-book')
        RETURNING id
        """
    ).fetchone()
    strategy_id = str(strategy_row[0])

    # 50 settled selections: 30 won at 2.0, 20 lost -- point ROI should be
    # (30*1.0 - 20*1.0) / 50 = 0.2, real numbers, not a mock.
    for i in range(50):
        fixture_id = _make_fixture(conn, i)
        won = i < 30
        odds_used = 2.0
        selection_row = conn.execute(
            """
            INSERT INTO selections (
                origin, fixture_id, strategy_id, competition, home, away, kickoff_utc,
                market, pick, verified_odds
            )
            VALUES ('auto_odds', %s, %s, 'Premier League', 'Home FC', 'Away FC', %s, 'moneyline', 'home', %s)
            RETURNING id
            """,
            (fixture_id, strategy_id, NOW - timedelta(days=60 - i), odds_used),
        ).fetchone()
        selection_id = str(selection_row[0])

        conn.execute(
            """
            INSERT INTO settlements (selection_id, status, settled_at, settlement_rule_version)
            VALUES (%s, %s, %s, 'v1')
            """,
            (selection_id, "won" if won else "lost", NOW - timedelta(days=59 - i)),
        )

        # Closing line, slightly worse than the price taken -> positive CLV.
        # Captured just before kickoff, matching real closing-line semantics.
        kickoff = NOW - timedelta(days=60 - i)
        conn.execute(
            """
            INSERT INTO odds_snapshots (fixture_id, bookmaker, market, selection, odds, captured_at, is_closing_line)
            VALUES (%s, 'pinnacle', 'moneyline', 'home', 1.9, %s, true)
            """,
            (fixture_id, kickoff - timedelta(minutes=5)),
        )

    conn.commit()

    written = score_all_strategies(conn, now=NOW)
    assert written == 3  # 30d, 90d, all windows

    row = conn.execute(
        """
        SELECT n_settled, roi, roi_ci_low, roi_ci_high, hit_rate, mean_clv, pct_positive_clv
        FROM strategy_scores
        WHERE strategy_id = %s AND "window" = 'all'
        """,
        (strategy_id,),
    ).fetchone()
    assert row is not None
    n_settled, roi, roi_ci_low, roi_ci_high, hit_rate_, mean_clv_, pct_positive_clv_ = row
    assert n_settled == 50
    assert float(roi) == pytest.approx(0.2, abs=1e-6)
    assert float(roi_ci_low) < 0.2 < float(roi_ci_high)
    assert float(hit_rate_) == pytest.approx(0.6)
    assert float(mean_clv_) == pytest.approx(2.0 / 1.9 - 1, abs=1e-6)
    assert float(pct_positive_clv_) == pytest.approx(1.0)  # every check beat the closing line here


def test_score_all_strategies_is_idempotent_on_rerun(conn):
    strategy_row = conn.execute(
        """
        INSERT INTO strategies (competition, market_class, edge_threshold, source_book)
        VALUES ('Premier League', 'moneyline', 0.02, 'local-book')
        RETURNING id
        """
    ).fetchone()
    strategy_id = str(strategy_row[0])
    conn.commit()

    first = score_all_strategies(conn, now=NOW)
    second = score_all_strategies(conn, now=NOW)
    assert first == second == 3

    count = conn.execute(
        'SELECT count(*) FROM strategy_scores WHERE strategy_id = %s', (strategy_id,)
    ).fetchone()[0]
    assert count == 3  # upsert, not a growing history
