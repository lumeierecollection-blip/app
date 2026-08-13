"""Integration test for the full B2 pipeline wiring, against real local
Postgres and two local fake HTTP servers standing in for API-Football and
OddsPapi (this sandbox can't reach the real hosts — that proof happens in
CI, see .github/workflows/ingest-e2e.yml). This test proves the pipeline
*wiring* is correct: fixture fetch -> odds fetch -> matching -> storage ->
closing-line finalization, all connected correctly end to end.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import psycopg
import pytest

from db import migrate
from ingestion.odds.run_once import run_once

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")

TODAY = date.today()
KICKOFF = f"{(TODAY + timedelta(days=3)).isoformat()}T19:00:00+00:00"
KICKOFF_ODDSPAPI = f"{(TODAY + timedelta(days=3)).isoformat()}T19:00:00.000Z"


class FakeApiFootballHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/leagues":
            body = {"response": [{"league": {"id": 39, "name": "Premier League"}}]}
        elif parsed.path == "/fixtures":
            body = {
                "response": [
                    {
                        "fixture": {"id": 900001, "date": KICKOFF},
                        "league": {"name": "Premier League"},
                        "teams": {"home": {"name": "Arsenal"}, "away": {"name": "Chelsea"}},
                    }
                ]
            }
        else:
            self.send_response(404)
            self.end_headers()
            return
        self._reply(body)

    def _reply(self, body):
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)


class FakeOddsPapiHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/v4/sports":
            body = [{"sportId": 10, "sportName": "Soccer"}]
        elif parsed.path == "/v4/tournaments":
            body = [{"tournamentId": 17, "tournamentName": "Premier League"}]
        elif parsed.path == "/v4/participants":
            ids = [int(i) for i in query.get("participantIds", [""])[0].split(",") if i]
            names = {42: "Arsenal", 11: "Chelsea"}
            body = [{"participantId": i, "participantName": names.get(i, f"team-{i}")} for i in ids]
        elif parsed.path == "/v4/odds-by-tournaments":
            body = [
                {
                    "fixtureId": "id900001",
                    "participant1Id": 42,
                    "participant2Id": 11,
                    "sportId": 10,
                    "tournamentId": 17,
                    "startTime": KICKOFF_ODDSPAPI,
                    "hasOdds": True,
                    "bookmakerOdds": {
                        "pinnacle": {
                            "markets": {
                                "101": {
                                    "bookmakerMarketId": "line/1/1/1/1/0/moneyline",
                                    "outcomes": {
                                        "101": {"players": {"0": {"active": True, "bookmakerOutcomeId": "home", "price": 1.9, "mainLine": True}}},
                                        "102": {"players": {"0": {"active": True, "bookmakerOutcomeId": "draw", "price": 3.6, "mainLine": True}}},
                                        "103": {"players": {"0": {"active": True, "bookmakerOutcomeId": "away", "price": 4.2, "mainLine": True}}},
                                    },
                                }
                            }
                        }
                    },
                }
            ]
        else:
            self.send_response(404)
            self.end_headers()
            return
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)


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
def fake_servers(monkeypatch):
    af_server = HTTPServer(("127.0.0.1", 0), FakeApiFootballHandler)
    op_server = HTTPServer(("127.0.0.1", 0), FakeOddsPapiHandler)
    threading.Thread(target=af_server.serve_forever, daemon=True).start()
    threading.Thread(target=op_server.serve_forever, daemon=True).start()

    monkeypatch.setattr(
        "ingestion.odds.api_football_provider.BASE_URL", f"http://127.0.0.1:{af_server.server_port}"
    )
    monkeypatch.setattr(
        "ingestion.odds.oddspapi_provider.BASE_URL", f"http://127.0.0.1:{op_server.server_port}/v4"
    )
    yield
    af_server.shutdown()
    op_server.shutdown()


def test_run_once_ingests_one_real_shaped_fixture_end_to_end(conn, fake_servers):
    result = run_once(conn, api_football_key="fake", oddspapi_key="fake")

    assert result["fixtures_processed"] == 1
    assert result["snapshots_written"] == 3  # home/draw/away

    fixture_row = conn.execute(
        "SELECT home, away, competition FROM fixtures WHERE provider_fixture_id = 900001"
    ).fetchone()
    assert fixture_row == ("Arsenal", "Chelsea", "Premier League")

    snapshots = conn.execute(
        "SELECT bookmaker, market, selection, odds FROM odds_snapshots"
    ).fetchall()
    assert len(snapshots) == 3
    by_selection = {row[2]: float(row[3]) for row in snapshots}
    assert by_selection == {"home": 1.9, "draw": 3.6, "away": 4.2}

    health_rows = conn.execute(
        "SELECT platform, status FROM ingestion_health ORDER BY platform"
    ).fetchall()
    assert ("api-football", "ok") in health_rows
    assert ("oddspapi", "ok") in health_rows


def test_run_once_is_safe_to_call_twice(conn, fake_servers):
    """Same fixture, ingested twice, must not duplicate the fixture row
    (upsert) and must add a second set of odds snapshots (append-only,
    not overwritten)."""
    run_once(conn, api_football_key="fake", oddspapi_key="fake")
    run_once(conn, api_football_key="fake", oddspapi_key="fake")

    fixture_count = conn.execute("SELECT count(*) FROM fixtures").fetchone()[0]
    assert fixture_count == 1

    snapshot_count = conn.execute("SELECT count(*) FROM odds_snapshots").fetchone()[0]
    assert snapshot_count == 6  # 3 quotes x 2 runs, never overwritten
