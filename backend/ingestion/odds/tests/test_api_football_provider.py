"""Tests for ApiFootballFixtureProvider.

Unlike test_oddspapi_provider.py, this uses synthetic data, clearly
marked as such: the real B1b probe (fixtures/provider_probes/
api_football_fixtures.json) returned zero results for the date it
happened to probe, so there's no real non-empty payload to replay. The
shape here follows API-Football's long-documented, stable v3 response
structure — confirm against real data (with real fixtures in range) the
first time the Task B2 end-to-end run actually exercises this path.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import date
from urllib.parse import urlparse, parse_qs

import pytest

from ingestion.http_client import HttpError
from ingestion.odds.api_football_provider import ApiFootballFixtureProvider

SYNTHETIC_LEAGUES_RESPONSE = {
    "response": [
        {"league": {"id": 39, "name": "Premier League"}},
        {"league": {"id": 40, "name": "Premier League 2"}},
    ]
}

SYNTHETIC_FIXTURES_RESPONSE = {
    "response": [
        {
            "fixture": {"id": 123456, "date": "2026-08-21T19:00:00+00:00"},
            "league": {"name": "Premier League"},
            "teams": {"home": {"name": "Team A"}, "away": {"name": "Team B"}},
        },
        {
            "fixture": {"id": 123457, "date": "2026-08-22T14:00:00+00:00"},
            "league": {"name": "Premier League"},
            "teams": {"home": {"name": "Team C"}, "away": {"name": "Team D"}},
        },
    ]
}


class FakeHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/leagues":
            search = query.get("search", [""])[0].lower()
            matches = [
                e for e in SYNTHETIC_LEAGUES_RESPONSE["response"]
                if search in e["league"]["name"].lower()
            ]
            body = {"response": matches}
        elif parsed.path == "/fixtures":
            assert "league" in query  # provider must resolve the id first
            body = SYNTHETIC_FIXTURES_RESPONSE
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
def provider(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), FakeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(
        "ingestion.odds.api_football_provider.BASE_URL", f"http://127.0.0.1:{server.server_port}"
    )
    yield ApiFootballFixtureProvider(api_key="fake-key")
    server.shutdown()


def test_find_league_id_matches_exact_name_case_insensitively(provider):
    assert provider.find_league_id("premier league") == 39


def test_fetch_upcoming_fixtures_resolves_league_then_fetches(provider):
    fixtures = provider.fetch_upcoming_fixtures(
        competition="Premier League",
        date_from=date(2026, 8, 20),
        date_to=date(2026, 8, 25),
    )
    assert len(fixtures) == 2
    assert fixtures[0].provider_fixture_id == 123456
    assert fixtures[0].home == "Team A"
    assert fixtures[0].away == "Team B"
    assert fixtures[0].kickoff_utc.isoformat() == "2026-08-21T19:00:00+00:00"


def test_fetch_upcoming_fixtures_raises_on_unknown_competition(provider):
    with pytest.raises(HttpError, match="No API-Football league found"):
        provider.fetch_upcoming_fixtures(
            competition="Not A Real League",
            date_from=date(2026, 8, 20),
            date_to=date(2026, 8, 25),
        )
