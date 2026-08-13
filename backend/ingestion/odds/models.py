"""Shared shapes for odds-market ingestion adapters (Task B2).

Provider-agnostic: whichever concrete FixtureProvider/OddsProvider
produced these, the rest of the pipeline (fixture matching, storage,
closing-line finalization) only ever sees RawFixture/RawOddsQuote.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class RawFixture:
    provider_fixture_id: int
    competition: str
    home: str
    away: str
    kickoff_utc: datetime


@dataclass(frozen=True)
class RawOddsQuote:
    provider_fixture_id: int  # the ODDS provider's own fixture id -- not fixtures.id
    home: str
    away: str
    kickoff_utc: datetime
    bookmaker: str
    market: str
    selection: str
    line: float | None
    odds: float
