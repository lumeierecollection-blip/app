"""OddsProviderRegistry — parallel fetch, dedupe, sort.

Ports the shape of tradeapp's SourceRegistry.fetchAll (Amendment C3):
fetch every registered provider concurrently, dedupe by a natural key,
sort by a stable field. Registered with exactly one provider (OddsPapi)
today; the point of building this now rather than calling OddsPapiProvider
directly is that Amendment B1's fallback plan (SportsGameOdds, SharpAPI)
slots in later as one more list entry, not a restructure.

Real concurrency, not a stub: Python's urllib calls block, so "parallel"
here is a thread pool — the direct equivalent of Dart's `Future.wait`
across blocking calls, not just a naming nod to the pattern.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from .models import RawOddsQuote
from .provider import OddsProvider


class OddsProviderRegistry:
    def __init__(self, providers: list[OddsProvider]) -> None:
        self._providers = providers

    @property
    def providers(self) -> list[OddsProvider]:
        return list(self._providers)

    def fetch_all(self, *, tournament_id: int, bookmaker: str) -> list[RawOddsQuote]:
        """Fetch from every registered provider in parallel, dedupe, sort.

        Dedupe key mirrors a quote's natural identity (there's no single
        `.id` field the way tradeapp's Signal has one) — two providers
        reporting the identical fixture/bookmaker/market/selection/line
        collapse to one entry, first-seen wins. Sorted by kickoff so
        output order is stable regardless of provider response timing.
        """
        with ThreadPoolExecutor(max_workers=max(1, len(self._providers))) as pool:
            results = list(
                pool.map(
                    lambda p: p.fetch_odds(tournament_id=tournament_id, bookmaker=bookmaker),
                    self._providers,
                )
            )

        seen: set[tuple] = set()
        quotes: list[RawOddsQuote] = []
        for batch in results:
            for quote in batch:
                key = (quote.provider_fixture_id, quote.bookmaker, quote.market, quote.selection, quote.line)
                if key not in seen:
                    seen.add(key)
                    quotes.append(quote)

        quotes.sort(key=lambda q: q.kickoff_utc)
        return quotes
