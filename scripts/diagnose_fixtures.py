"""Diagnostic: why did the B2 end-to-end run find 0 Premier League
fixtures in a 14-day window?

Not part of the ingestion pipeline itself -- run once via CI (this
sandbox has no network access to confirm any of this directly) to
distinguish between two very different explanations before assuming
either:

1. A genuine scheduling gap (the 14-day window from run-time didn't
   happen to overlap any fixture) -- not a bug, just an unlucky
   window/date to have proven B2 against.
2. A real bug in ApiFootballFixtureProvider: wrong league resolved
   (there are many "Premier League"-named competitions across
   countries), wrong `season` parameter convention, or something else
   in the query.

Prints the raw /leagues search response (every match, not just the one
this project's resolver picked) and fixtures over a much wider window
for whichever league id gets resolved, so the answer is visible rather
than guessed.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from ingestion.http_client import get_json  # noqa: E402
from ingestion.odds.api_football_provider import BASE_URL  # noqa: E402


def main() -> int:
    api_key = os.environ.get("API_FOOTBALL_KEY")
    if not api_key:
        print("API_FOOTBALL_KEY not set", file=sys.stderr)
        return 1
    headers = {"x-apisports-key": api_key}

    print("=== /leagues?search=Premier League (every match, not just the resolved one) ===")
    resp = get_json(f"{BASE_URL}/leagues?search=Premier%20League", headers=headers)
    leagues = resp.body.get("response", [])
    for entry in leagues:
        league = entry.get("league", {})
        country = entry.get("country", {})
        seasons = entry.get("seasons", [])
        current_seasons = [s for s in seasons if s.get("current")]
        print(
            f"id={league.get('id')} name={league.get('name')!r} "
            f"country={country.get('name')} current_season={current_seasons}"
        )

    if not leagues:
        print("No leagues matched at all -- the search itself may be wrong.")
        return 0

    # Use this project's own resolution logic (exact case-insensitive
    # match, else first result) so the diagnosis reflects what run_once
    # actually does, not a different query.
    exact = [e for e in leagues if str(e["league"]["name"]).lower() == "premier league"]
    chosen = exact[0] if exact else leagues[0]
    league_id = chosen["league"]["id"]
    print(f"\n=== Resolved league_id (matches ApiFootballFixtureProvider.find_league_id): {league_id} ===")

    today = date.today()
    print(f"\n=== Fixtures for league {league_id}, today={today.isoformat()}, +/- 45 days, no season filter ===")
    wide_from = today - timedelta(days=45)
    wide_to = today + timedelta(days=45)
    resp = get_json(
        f"{BASE_URL}/fixtures?league={league_id}&from={wide_from.isoformat()}&to={wide_to.isoformat()}",
        headers=headers,
    )
    fixtures = resp.body.get("response", [])
    print(f"Fixtures found (no season param, 90-day window): {len(fixtures)}")
    for f in fixtures[:10]:
        fx = f.get("fixture", {})
        teams = f.get("teams", {})
        print(
            f"  {fx.get('date')} — {teams.get('home', {}).get('name')} vs "
            f"{teams.get('away', {}).get('name')}"
        )

    for season in (today.year, today.year - 1):
        print(f"\n=== Same window, season={season} ===")
        resp = get_json(
            f"{BASE_URL}/fixtures?league={league_id}&season={season}"
            f"&from={wide_from.isoformat()}&to={wide_to.isoformat()}",
            headers=headers,
        )
        fixtures = resp.body.get("response", [])
        print(f"Fixtures found (season={season}): {len(fixtures)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
