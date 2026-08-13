"""API-Football fixture provider.

Base URL and auth header (`x-apisports-key`) are live-confirmed
(Task B1b: `/status` returned a real account, `/fixtures?date=...`
returned a real — if empty — 200 response). The exact response *shape*
for a date range that actually has fixtures is not yet live-confirmed
from this project's own probes (the B1b date happened to have zero
matches) — it's built from API-Football's long-stable, widely-documented
v3 shape (`fixture.id`/`fixture.date`, `teams.home.name`/`teams.away.name`,
`league.name`), and this module raises clearly rather than silently
mis-parsing if that shape doesn't hold. Confirm against the Task B2
end-to-end run and update this note once real fixtures have been parsed.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from urllib.parse import quote

from ..http_client import HttpError, get_json
from .models import RawFixture
from .provider import FixtureProvider

BASE_URL = "https://v3.football.api-sports.io"


class ApiFootballFixtureProvider(FixtureProvider):
    key = "api-football"
    name = "API-Football"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key
        self._headers = {"x-apisports-key": api_key}

    def find_league_id(self, name: str) -> int | None:
        """Look up a league's numeric id by name rather than hardcoding one.

        Avoids baking in an unconfirmed "EPL is league 39"-style constant
        — the id is resolved live and can be inspected/logged at call time.
        """
        url = f"{BASE_URL}/leagues?search={quote(name)}"
        try:
            response = get_json(url, headers=self._headers)
        except HttpError as exc:
            raise HttpError(f"find_league_id({name!r}) failed: {exc}") from exc
        results = response.body.get("response", []) if isinstance(response.body, dict) else []
        for entry in results:
            league = entry.get("league", {}) if isinstance(entry, dict) else {}
            if str(league.get("name", "")).lower() == name.lower():
                league_id = league.get("id")
                return int(league_id) if league_id is not None else None
        # Fall back to the first result if no exact (case-insensitive) match.
        if results:
            league_id = results[0].get("league", {}).get("id")
            return int(league_id) if league_id is not None else None
        return None

    def fetch_upcoming_fixtures(
        self, *, competition: str, date_from: date, date_to: date
    ) -> list[RawFixture]:
        league_id = self.find_league_id(competition)
        if league_id is None:
            raise HttpError(f"No API-Football league found matching {competition!r}")

        url = (
            f"{BASE_URL}/fixtures?league={league_id}"
            f"&from={date_from.isoformat()}&to={date_to.isoformat()}"
            f"&season={date_from.year}"
        )
        response = get_json(url, headers=self._headers)
        entries = response.body.get("response", []) if isinstance(response.body, dict) else None
        if entries is None:
            raise HttpError(
                f"Unexpected /fixtures response shape (no 'response' key): "
                f"{str(response.body)[:300]}"
            )

        fixtures: list[RawFixture] = []
        for entry in entries:
            try:
                fixture_block = entry["fixture"]
                teams_block = entry["teams"]
                league_block = entry["league"]
                fixtures.append(
                    RawFixture(
                        provider_fixture_id=int(fixture_block["id"]),
                        competition=str(league_block["name"]),
                        home=str(teams_block["home"]["name"]),
                        away=str(teams_block["away"]["name"]),
                        kickoff_utc=_parse_utc(fixture_block["date"]),
                    )
                )
            except (KeyError, TypeError, ValueError) as exc:
                raise HttpError(
                    f"Unexpected fixture entry shape from API-Football: {exc}. "
                    f"Entry: {str(entry)[:300]}"
                ) from exc
        return fixtures


def _parse_utc(iso_string: str) -> datetime:
    dt = datetime.fromisoformat(iso_string)
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
