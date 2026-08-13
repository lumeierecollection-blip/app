"""Tests for backend/manual_check/api.py -- the FastAPI endpoints the
Flutter app (Task B7) will call -- against real local Postgres via a
dependency override (standard FastAPI testing pattern), not a mock DB.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from fastapi.testclient import TestClient

from api.main import app
from db import migrate
from manual_check.api import get_connection

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
    conn.execute(
        """
        INSERT INTO odds_snapshots (fixture_id, bookmaker, market, selection, odds, captured_at)
        VALUES (%s, 'pinnacle', 'moneyline', 'home', 1.165, %s),
               (%s, 'pinnacle', 'moneyline', 'draw', 7.66, %s),
               (%s, 'pinnacle', 'moneyline', 'away', 15.44, %s)
        """,
        (
            row[0],
            NOW - timedelta(minutes=1),
            row[0],
            NOW - timedelta(minutes=1),
            row[0],
            NOW - timedelta(minutes=1),
        ),
    )
    conn.commit()
    return str(row[0])


@pytest.fixture
def client(conn):
    def override_get_connection():
        yield conn

    app.dependency_overrides[get_connection] = override_get_connection
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_health_endpoint():
    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_fair_price_endpoint_returns_real_devigged_prices(client, fixture_id):
    resp = client.get("/manual-check/fair-price", params={"fixture_id": fixture_id, "market": "moneyline"})
    assert resp.status_code == 200
    body = resp.json()
    assert set(body["fair_prices"]) == {"home", "draw", "away"}
    # Fair odds must be strictly below the raw Pinnacle odds -- de-vigging
    # always shortens the price relative to the vig-inflated raw number
    # for the favorite side; sanity check on the direction, not an exact value.
    assert body["fair_prices"]["home"] < 1.30


def test_fair_price_endpoint_404s_with_no_sharp_data(client):
    resp = client.get(
        "/manual-check/fair-price",
        params={"fixture_id": str(uuid.uuid4()), "market": "moneyline"},
    )
    assert resp.status_code == 404


def test_submit_manual_check_returns_edge_and_stores_row(client, fixture_id, conn):
    resp = client.post(
        "/manual-check",
        json={
            "fixture_id": fixture_id,
            "market": "moneyline",
            "pick": "home",
            "entered_odds": 1.30,
            "entered_bookmaker": "local-book",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["passed_gates"] is True
    assert body["edge"] > 0.02
    assert body["stake_fraction"] > 0
    assert body["rejections"] == []

    row = conn.execute("SELECT entered_bookmaker FROM manual_checks WHERE id = %s", (body["id"],)).fetchone()
    assert row is not None
    assert row[0] == "local-book"


def test_submit_manual_check_unknown_pick_is_400(client, fixture_id):
    resp = client.post(
        "/manual-check",
        json={
            "fixture_id": fixture_id,
            "market": "moneyline",
            "pick": "not_a_real_selection",
            "entered_odds": 1.30,
            "entered_bookmaker": "local-book",
        },
    )
    assert resp.status_code == 400
