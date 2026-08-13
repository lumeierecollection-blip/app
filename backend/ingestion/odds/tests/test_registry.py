from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from ingestion.odds.models import RawOddsQuote
from ingestion.odds.provider import OddsProvider
from ingestion.odds.registry import OddsProviderRegistry

KICKOFF = datetime(2026, 8, 21, 19, 0, tzinfo=timezone.utc)


def _quote(provider_fixture_id, kickoff_utc, **overrides):
    defaults = dict(
        provider_fixture_id=provider_fixture_id,
        home="Arsenal",
        away="Chelsea",
        kickoff_utc=kickoff_utc,
        bookmaker="pinnacle",
        market="h2h",
        selection="home",
        line=None,
        odds=1.9,
    )
    defaults.update(overrides)
    return RawOddsQuote(**defaults)


class SlowFakeProvider(OddsProvider):
    """Sleeps to prove fetch_all runs providers concurrently, not
    sequentially -- if it ran sequentially, two 0.2s providers would take
    ~0.4s; run in parallel they take ~0.2s."""

    key = "slow-fake"
    name = "Slow Fake"

    def __init__(self, quotes: list[RawOddsQuote], delay: float = 0.2) -> None:
        self._quotes = quotes
        self._delay = delay

    def fetch_odds(self, *, tournament_id: int, bookmaker: str) -> list[RawOddsQuote]:
        time.sleep(self._delay)
        return self._quotes


def test_fetch_all_runs_providers_concurrently_not_sequentially():
    providers = [
        SlowFakeProvider([_quote(1, KICKOFF)], delay=0.2),
        SlowFakeProvider([_quote(2, KICKOFF)], delay=0.2),
    ]
    registry = OddsProviderRegistry(providers)

    start = time.monotonic()
    registry.fetch_all(tournament_id=17, bookmaker="pinnacle")
    elapsed = time.monotonic() - start

    assert elapsed < 0.35, f"expected concurrent execution (~0.2s), took {elapsed:.2f}s"


def test_fetch_all_dedupes_identical_quotes_across_providers():
    shared_quote = _quote(1, KICKOFF, odds=1.90)
    providers = [
        SlowFakeProvider([shared_quote], delay=0),
        SlowFakeProvider([shared_quote], delay=0),
    ]
    registry = OddsProviderRegistry(providers)
    quotes = registry.fetch_all(tournament_id=17, bookmaker="pinnacle")
    assert len(quotes) == 1


def test_fetch_all_keeps_distinct_quotes_from_different_providers():
    providers = [
        SlowFakeProvider([_quote(1, KICKOFF)], delay=0),
        SlowFakeProvider([_quote(2, KICKOFF)], delay=0),
    ]
    registry = OddsProviderRegistry(providers)
    quotes = registry.fetch_all(tournament_id=17, bookmaker="pinnacle")
    assert {q.provider_fixture_id for q in quotes} == {1, 2}


def test_fetch_all_sorts_by_kickoff():
    later = KICKOFF + timedelta(days=1)
    providers = [
        SlowFakeProvider([_quote(2, later)], delay=0),
        SlowFakeProvider([_quote(1, KICKOFF)], delay=0),
    ]
    registry = OddsProviderRegistry(providers)
    quotes = registry.fetch_all(tournament_id=17, bookmaker="pinnacle")
    assert [q.provider_fixture_id for q in quotes] == [1, 2]
