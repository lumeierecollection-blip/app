"""Adapter base classes for the odds-market ingestion path.

Mirrors the SignalSource/SourceRegistry pattern ported from
lumeierecollection-blip/tradeapp (Amendment C3) — an abstract adapter
per data source, with the concrete HTTP/parsing detail contained in one
subclass per provider. `key`/`name` match the naming the tradeapp
pattern uses (`SignalSource.key`/`.name`) so future providers slot in
the same way; there's no `requiresSetup` equivalent yet because every
provider currently registered needs an API key, unlike tradeapp's mix of
zero-config and login-backed sources.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date

from .models import RawFixture, RawOddsQuote


class FixtureProvider(ABC):
    key: str
    name: str

    @abstractmethod
    def fetch_upcoming_fixtures(
        self, *, competition: str, date_from: date, date_to: date
    ) -> list[RawFixture]:
        """Fixtures for one competition in [date_from, date_to], inclusive."""


class OddsProvider(ABC):
    key: str
    name: str

    @abstractmethod
    def fetch_odds(self, *, tournament_id: int, bookmaker: str) -> list[RawOddsQuote]:
        """Every fixture with priced odds from `bookmaker` in this tournament."""
