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
            # Shaped like the real, live-confirmed response: an "account"
            # block with the account holder's real name/email sits
            # alongside the subscription/requests info this script needs.
            body = {
                "response": {
                    "account": {"firstname": "Test", "lastname": "Person", "email": "test@example.com"},
                    "subscription": {"plan": "Free", "active": True},
                    "requests": {"current": 3, "limit_day": 100},
                }
            }
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


class AllOddsCallsFailHandler(FakeProviderHandler):
    """Same as FakeProviderHandler, but /v4/odds-by-tournaments always 500s.

    Reproduces the exact shape of the live 1xBet rate-limit failure, for
    every bookmaker in the loop rather than just one -- the scenario that
    would previously leave `headers` unassigned and crash the function
    with UnboundLocalError instead of returning findings with the
    failures recorded.
    """

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/v4/odds-by-tournaments":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b'{"error": "simulated failure"}')
            return
        super().do_GET()


def _start_server(handler=FakeProviderHandler) -> HTTPServer:
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def test_probe_odds_provider_survives_every_odds_call_failing(monkeypatch, tmp_path):
    """Regression test for the pre-fix UnboundLocalError.

    Before bookmakers_headers/odds_headers were split out, `headers` was
    only ever assigned inside the per-bookmaker loop's try block. If
    every bookmaker's odds-by-tournaments call failed (as the live 1xBet
    call did with a 429), the function would raise UnboundLocalError
    instead of returning findings with the failures recorded.
    """
    server = _start_server(handler=AllOddsCallsFailHandler)
    base = f"http://127.0.0.1:{server.server_port}/v4"
    monkeypatch.setattr(vp, "ODDS_PROVIDER_BASE", base)
    monkeypatch.setattr(vp, "FIXTURES_DIR", tmp_path)

    try:
        findings = vp.probe_odds_provider("fake-key")  # must not raise
    finally:
        server.shutdown()

    assert findings["catalog_has_pinnacle"] is True  # /bookmakers still worked
    assert "error" in findings["odds_call_pinnacle"]
    assert "error" in findings["odds_call_1xbet"]
    assert len(findings["errors"]) == 2
    # Reflects /bookmakers's headers (the fake server sends this on every
    # 200 response) -- proves rate_limit_headers comes from that call, not
    # from whichever odds-by-tournaments call happened to run last (they
    # all failed here, so there is no "last successful" one to fall back to).
    assert findings["rate_limit_headers"] == {"X-RateLimit-Remaining": "42"}


def test_probe_odds_provider_against_local_server(monkeypatch, tmp_path):
    server = _start_server()
    base = f"http://127.0.0.1:{server.server_port}/v4"
    monkeypatch.setattr(vp, "ODDS_PROVIDER_BASE", base)
    monkeypatch.setattr(vp, "FIXTURES_DIR", tmp_path)

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


def test_probe_api_football_against_local_server(monkeypatch, tmp_path):
    server = _start_server()
    base = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setattr(vp, "API_FOOTBALL_BASE", base)
    monkeypatch.setattr(vp, "FIXTURES_DIR", tmp_path)

    try:
        findings = vp.probe_api_football("fake-key")
    finally:
        server.shutdown()

    assert findings["account_status"]["requests"]["limit_day"] == 100
    assert findings["fixtures_returned"] == 2
    assert findings["errors"] == []

    # The account holder's real name/email must never survive into
    # findings or the saved fixture -- confirmed live that API-Football's
    # /status returns them, and the first real run saved them unfiltered
    # before this scrub existed.
    assert "account" not in findings["account_status"]
    saved = json.loads((tmp_path / "api_football_status.json").read_text())
    assert "account" not in saved["body"]["response"]
    assert "Test" not in json.dumps(saved)
    assert "test@example.com" not in json.dumps(saved)


def test_scrub_account_pii_removes_nested_account_blocks():
    scrubbed = vp._scrub_account_pii(
        {
            "response": {
                "account": {"firstname": "A", "email": "a@example.com"},
                "subscription": {"plan": "Free"},
            },
            "results": 1,
        }
    )
    assert "account" not in scrubbed["response"]
    assert scrubbed["response"]["subscription"]["plan"] == "Free"
    assert scrubbed["results"] == 1


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
