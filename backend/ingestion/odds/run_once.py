"""One ingestion pass for the odds-market path (Task B2 end-to-end proof).

For a configured competition: fetch upcoming fixtures from API-Football,
fetch sharp-book odds from OddsPapi for the matching tournament, match
each fixture across providers, and store every match plus its odds
snapshots. Records ingestion_health for both providers regardless of
outcome, and finalizes closing lines for anything that has kicked off.

Assumes migrations are already applied (run `python3 -m db.migrate`
first) — this module only ingests, it doesn't own schema setup.

This is a single, unconditional pass proving the pipeline works against
real data end to end. The poll-schedule integration (poller.py deciding
*which* fixtures are due right now) is what a recurring cron job wires
in on top of this — not rebuilt here, since B2's proof is "does the
pipeline work at all," not "run it forever on a schedule."
"""

from __future__ import annotations

import os
import sys
from datetime import date, timedelta

import psycopg

from ..http_client import HttpError
from .api_football_provider import ApiFootballFixtureProvider
from .fixture_matching import find_matching_provider_fixture_id
from .oddspapi_provider import OddsPapiProvider
from .registry import OddsProviderRegistry
from .storage import (
    finalize_closing_lines,
    insert_odds_snapshot,
    record_ingestion_health,
    upsert_fixture,
)

DEFAULT_COMPETITION = "Premier League"
SHARP_BOOKMAKER = "pinnacle"
LOOKAHEAD_DAYS = 14


def run_once(
    conn: psycopg.Connection,
    *,
    api_football_key: str,
    oddspapi_key: str,
    competition: str = DEFAULT_COMPETITION,
) -> dict:
    fixture_provider = ApiFootballFixtureProvider(api_football_key)
    odds_provider = OddsPapiProvider(oddspapi_key)
    registry = OddsProviderRegistry([odds_provider])

    today = date.today()
    try:
        raw_fixtures = fixture_provider.fetch_upcoming_fixtures(
            competition=competition,
            date_from=today,
            date_to=today + timedelta(days=LOOKAHEAD_DAYS),
        )
    except HttpError as exc:
        record_ingestion_health(conn, platform="api-football", status="error", detail=str(exc))
        conn.commit()
        raise
    record_ingestion_health(
        conn,
        platform="api-football",
        status="ok" if raw_fixtures else "empty",
        detail=f"{len(raw_fixtures)} fixtures for {competition!r} in the next {LOOKAHEAD_DAYS}d",
    )
    conn.commit()

    if not raw_fixtures:
        return {"fixtures_processed": 0, "snapshots_written": 0, "closing_lines_flagged": 0}

    sport_id = odds_provider.find_sport_id("soccer")
    tournament_id = odds_provider.find_tournament_id(sport_id, competition) if sport_id else None
    if tournament_id is None:
        record_ingestion_health(
            conn, platform="oddspapi", status="error",
            detail=f"could not resolve an OddsPapi tournament id for {competition!r}",
        )
        conn.commit()
        return {"fixtures_processed": 0, "snapshots_written": 0, "closing_lines_flagged": 0}

    try:
        quotes = registry.fetch_all(tournament_id=tournament_id, bookmaker=SHARP_BOOKMAKER)
    except HttpError as exc:
        record_ingestion_health(conn, platform="oddspapi", status="error", detail=str(exc))
        conn.commit()
        raise
    record_ingestion_health(
        conn,
        platform="oddspapi",
        status="ok" if quotes else "empty",
        detail=f"{len(quotes)} {SHARP_BOOKMAKER} quotes for tournament {tournament_id}",
    )
    conn.commit()

    fixtures_processed = 0
    snapshots_written = 0
    for raw_fixture in raw_fixtures:
        matched_id = find_matching_provider_fixture_id(raw_fixture, quotes)
        if matched_id is None:
            continue
        fixture_row_id = upsert_fixture(conn, raw_fixture)
        for quote in quotes:
            if quote.provider_fixture_id != matched_id:
                continue
            insert_odds_snapshot(conn, fixture_row_id, quote)
            snapshots_written += 1
        fixtures_processed += 1
        conn.commit()

    closing_lines_flagged = finalize_closing_lines(conn)
    conn.commit()

    return {
        "fixtures_processed": fixtures_processed,
        "snapshots_written": snapshots_written,
        "closing_lines_flagged": closing_lines_flagged,
    }


def main() -> int:
    database_url = os.environ.get("DATABASE_URL")
    api_football_key = os.environ.get("API_FOOTBALL_KEY")
    oddspapi_key = os.environ.get("ODDS_PROVIDER_API_KEY")

    missing = [
        name for name, val in (
            ("DATABASE_URL", database_url),
            ("API_FOOTBALL_KEY", api_football_key),
            ("ODDS_PROVIDER_API_KEY", oddspapi_key),
        )
        if not val
    ]
    if missing:
        print(f"Missing required env var(s): {', '.join(missing)}", file=sys.stderr)
        return 1

    with psycopg.connect(database_url) as conn:
        result = run_once(conn, api_football_key=api_football_key, oddspapi_key=oddspapi_key)

    print(f"Fixtures processed: {result['fixtures_processed']}")
    print(f"Odds snapshots written: {result['snapshots_written']}")
    print(f"Closing lines flagged: {result['closing_lines_flagged']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
