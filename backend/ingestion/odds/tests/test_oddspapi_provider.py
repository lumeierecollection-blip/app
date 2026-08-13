"""Tests for OddsPapiProvider against the real captured B1b payload.

fixtures/provider_probes/oddspapi_odds_pinnacle.json is not synthetic —
it's the actual response OddsPapi returned for real Premier League
fixtures during the Task B1b live verification run. Replaying it from a
local server proves the parser handles real data, not a shape this
session invented to make its own tests pass.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from ingestion.odds.oddspapi_provider import OddsPapiProvider, _classify_outcome

REPO_ROOT = Path(__file__).resolve().parents[4]
REAL_ODDS_PAYLOAD = json.loads(
    (REPO_ROOT / "fixtures" / "provider_probes" / "oddspapi_odds_pinnacle.json").read_text()
)["body"]


class ReplayHandler(BaseHTTPRequestHandler):
    """Serves the real captured odds payload, plus a synthetic participants
    response (no real one was captured — see the provider module's
    docstring on why that endpoint's shape is unconfirmed)."""

    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path == "/v4/odds-by-tournaments":
            body = REAL_ODDS_PAYLOAD
        elif parsed.path == "/v4/participants":
            ids = [int(i) for i in query.get("participantIds", [""])[0].split(",") if i]
            body = [
                {"participantId": i, "participantName": f"Team {i}"} for i in ids
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
def provider(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), ReplayHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(
        "ingestion.odds.oddspapi_provider.BASE_URL", f"http://127.0.0.1:{server.server_port}/v4"
    )
    yield OddsPapiProvider(api_key="fake-key")
    server.shutdown()


def test_fetch_odds_parses_all_ten_real_fixtures(provider):
    quotes = provider.fetch_odds(tournament_id=17, bookmaker="pinnacle")
    fixture_ids = {q.provider_fixture_id for q in quotes}
    # 10 distinct fixtures in the real captured payload, all hasOdds=True.
    assert len(fixture_ids) == 10
    assert 1000001772221154 in fixture_ids  # the first real fixture, used below


def test_fetch_odds_resolves_h2h_market_for_first_real_fixture(provider):
    quotes = provider.fetch_odds(tournament_id=17, bookmaker="pinnacle")
    h2h = [
        q for q in quotes
        if q.provider_fixture_id == 1000001772221154 and q.market == "h2h"
    ]
    selections = {q.selection: q.odds for q in h2h}
    # Real values captured live: home 1.165, draw 7.66, away 15.44.
    assert selections.get("home") == pytest.approx(1.165)
    assert selections.get("draw") == pytest.approx(7.66)
    assert selections.get("away") == pytest.approx(15.44)


def test_fetch_odds_resolves_only_the_main_totals_line(provider):
    """Real data has ~10 alternate total lines per fixture (2.0, 2.25,
    2.5, 2.75, 3.0, 3.25, 3.5, 3.75, 4.0 -- all mainLine: false) plus one
    designated main line (3.0, mainLine: true). Only the main one should
    survive -- the alternates are out of scope for B2 (see module
    docstring)."""
    quotes = provider.fetch_odds(tournament_id=17, bookmaker="pinnacle")
    totals = [
        q for q in quotes
        if q.provider_fixture_id == 1000001772221154 and q.market == "totals"
    ]
    lines_seen = {q.line for q in totals}
    assert lines_seen == {3.0}, f"expected only the mainLine total (3.0), got {lines_seen}"
    by_selection = {q.selection: q.odds for q in totals}
    assert by_selection.get("over") == pytest.approx(1.952)
    assert by_selection.get("under") == pytest.approx(1.884)


def test_fetch_odds_excludes_period_1_markets(provider):
    """Period "1" has its own moneyline market with the same outcome ids
    ("home"/"draw"/"away") as period "0" but different, real prices
    (1.534/3.0/12.91 vs period 0's 1.165/7.66/15.44). Only period 0 (the
    full match) should ever produce a quote."""
    quotes = provider.fetch_odds(tournament_id=17, bookmaker="pinnacle")
    h2h_odds = {
        q.odds
        for q in quotes
        if q.provider_fixture_id == 1000001772221154 and q.market == "h2h"
    }
    assert 1.534 not in h2h_odds  # period 1's "home" price -- must not leak in


def test_fetch_odds_produces_exactly_five_quotes_per_fixture(provider):
    """3 moneyline (home/draw/away) + 2 totals (over/under at the main
    line) -- confirmed by hand against the real captured payload for the
    first fixture. Spreads, teamTotal, and alternate total lines (~31
    more markets/outcomes per fixture in the real data) are correctly
    excluded."""
    quotes = provider.fetch_odds(tournament_id=17, bookmaker="pinnacle")
    for_first_fixture = [q for q in quotes if q.provider_fixture_id == 1000001772221154]
    assert len(for_first_fixture) == 5


def test_fetch_odds_gives_every_quote_a_team_name_not_a_bare_id(provider):
    quotes = provider.fetch_odds(tournament_id=17, bookmaker="pinnacle")
    for q in quotes:
        assert q.home and q.away
        assert isinstance(q.home, str) and isinstance(q.away, str)


@pytest.mark.parametrize(
    "outcome_id,expected",
    [
        ("home", ("h2h", "home", None)),
        ("draw", ("h2h", "draw", None)),
        ("away", ("h2h", "away", None)),
        ("2.5/over", ("totals", "over", 2.5)),
        ("2.5/under", ("totals", "under", 2.5)),
        ("weird-future-market", ("other", "weird-future-market", None)),
    ],
)
def test_classify_outcome(outcome_id, expected):
    assert _classify_outcome(outcome_id) == expected
