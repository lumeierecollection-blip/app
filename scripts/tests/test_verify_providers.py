"""Local-server test for verify_providers.py.

This session's sandbox can't reach the real OddsPapi/API-Football hosts,
so this is the closest thing to an integration test available here: a
real local HTTP server, real urllib requests over a real socket, canned
JSON shaped like the documented (search-corroborated, not fabricated)
response schemas. It exists to catch parsing bugs before the script's
first real run in CI, not to assert anything about the providers
themselves.
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import verify_providers as vp  # noqa: E402

ODDSPAPI_ROUTES = {
    "/v4/sports": [
        {"sportId": 1, "sportName": "Football"},
        {"sportId": 2, "sportName": "Basketball"},
    ],
    "/v4/tournaments": [
        {
            "tournamentId": 17,
            "tournamentName": "English Premier League",
            "categoryName": "England",
            "upcomingFixtures": 12,
        },
        {"tournamentId": 8, "tournamentName": "La Liga", "upcomingFixtures": 9},
    ],
    "/v4/bookmakers": [
        {"bookmakerName": "Pinnacle"},
        {"bookmakerName": "Bet365"},
        {"bookmakerName": "1xBet"},
    ],
}


class FakeProviderHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence test output
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path == "/v4/odds-by-tournaments":
            book = query.get("bookmaker", [""])[0]
            has_odds = book == "pinnacle"  # simulate: pinnacle priced, 1xbet not
            body = [
                {
                    "fixtureId": 555,
                    "sportId": 1,
                    "tournamentId": 17,
                    "hasOdds": has_odds,
                    "bookmakerOdds": {"h2h": [2.1, 3.4, 3.6]} if has_odds else {},
                }
            ]
        elif parsed.path == "/status":
            body = {"response": {"requests": {"current": 3, "limit_day": 100}}}
        elif parsed.path == "/fixtures":
            body = {"response": [{"fixture": {"id": 1}}, {"fixture": {"id": 2}}]}
        elif parsed.path in ODDSPAPI_ROUTES:
            body = ODDSPAPI_ROUTES[parsed.path]
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"{}")
            return

        payload = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-RateLimit-Remaining", "42")
        self.end_headers()
        self.wfile.write(payload)


def _start_server() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", 0), FakeProviderHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def test_probe_odds_provider_against_local_server(monkeypatch):
    server = _start_server()
    base = f"http://127.0.0.1:{server.server_port}/v4"
    monkeypatch.setattr(vp, "ODDS_PROVIDER_BASE", base)
    monkeypatch.setattr(vp, "FIXTURES_DIR", Path("/tmp/verify_providers_test_probes"))

    try:
        findings = vp.probe_odds_provider("fake-key")
    finally:
        server.shutdown()

    assert findings["football_sport"]["sportId"] == 1
    assert findings["catalog_has_pinnacle"] is True
    assert findings["catalog_has_1xbet"] is True
    assert findings["odds_call_pinnacle"]["fixtures_with_priced_odds"] == 1
    assert findings["odds_call_1xbet"]["fixtures_with_priced_odds"] == 0
    assert findings["errors"] == []


def test_probe_api_football_against_local_server(monkeypatch):
    server = _start_server()
    base = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setattr(vp, "API_FOOTBALL_BASE", base)
    monkeypatch.setattr(vp, "FIXTURES_DIR", Path("/tmp/verify_providers_test_probes"))

    try:
        findings = vp.probe_api_football("fake-key")
    finally:
        server.shutdown()

    assert findings["account_status"]["requests"]["limit_day"] == 100
    assert findings["fixtures_returned"] == 2
    assert findings["errors"] == []


def test_decision_table_flags_missing_pinnacle_coverage():
    odds = {
        "football_sport": {"sportId": 1},
        "tournament_count": 5,
        "target_tournament": {"tournamentName": "EPL", "tournamentId": 17},
        "bookmaker_catalog_size": 3,
        "catalog_has_pinnacle": False,
        "catalog_has_1xbet": True,
        "odds_call_pinnacle": {"fixtures_returned": 1, "fixtures_with_priced_odds": 0},
        "odds_call_1xbet": {"fixtures_returned": 1, "fixtures_with_priced_odds": 1},
        "rate_limit_headers": {},
        "errors": [],
    }
    football = {
        "account_status": {"requests": {"current": 1, "limit_day": 100}},
        "fixtures_probe_date": "2026-08-20",
        "fixtures_returned": 4,
        "rate_limit_headers": {},
        "errors": [],
    }
    table = vp.render_decision_table(odds, football)
    assert "Pinnacle coverage on OddsPapi confirmed live: False" in table
    assert "Do NOT build B3's edge math" in table


def test_missing_env_vars_exit_nonzero(monkeypatch, capsys):
    monkeypatch.delenv("API_FOOTBALL_KEY", raising=False)
    monkeypatch.delenv("ODDS_PROVIDER_API_KEY", raising=False)
    assert vp.main() == 1
    assert "Missing required env var" in capsys.readouterr().err
