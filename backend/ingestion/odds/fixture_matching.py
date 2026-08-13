"""Fixture identity resolution (Amendment B2 — "real tax, budget real time").

API-Football and OddsPapi assign different internal ids to the same
real-world match. This module matches a canonical RawFixture (from
API-Football) against the fixture identity carried on OddsPapi's
RawOddsQuote objects, using team names (normalized + alias-resolved) and
kickoff proximity — never a guess when the result is ambiguous.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import timedelta

from .models import RawFixture, RawOddsQuote

DEFAULT_KICKOFF_TOLERANCE = timedelta(hours=3)

# Seeded with real, well-known naming variants for clubs likely to appear
# in a major European league. This table is expected to grow — a name
# not in here isn't a bug, it's the next entry to add once a real
# mismatch is observed in production data. Never invented beyond common,
# widely-known club nicknames/short forms.
TEAM_ALIASES: dict[str, str] = {
    "man utd": "manchester united",
    "man united": "manchester united",
    "manchester utd": "manchester united",
    "man city": "manchester city",
    "spurs": "tottenham hotspur",
    "tottenham": "tottenham hotspur",
    "wolves": "wolverhampton wanderers",
    "nottm forest": "nottingham forest",
    "nott'm forest": "nottingham forest",
    "brighton": "brighton and hove albion",
    "brighton hove albion": "brighton and hove albion",
    "west ham": "west ham united",
    "newcastle": "newcastle united",
    "leeds": "leeds united",
}

_CLUB_SUFFIXES = re.compile(r"\b(fc|cf|afc|sc|cd|ac)\b")
_NON_ALPHANUMERIC = re.compile(r"[^a-z0-9 ]")
_EXTRA_WHITESPACE = re.compile(r"\s+")


def normalize_team_name(name: str) -> str:
    """Lowercase, strip accents/suffixes/punctuation, resolve aliases."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    lowered = ascii_name.lower().strip()
    no_suffix = _CLUB_SUFFIXES.sub("", lowered)
    alnum_only = _NON_ALPHANUMERIC.sub("", no_suffix)
    collapsed = _EXTRA_WHITESPACE.sub(" ", alnum_only).strip()
    return TEAM_ALIASES.get(collapsed, collapsed)


@dataclass(frozen=True)
class NoMatchReason:
    reason: str


def _quote_matches(
    canonical: RawFixture, quote: RawOddsQuote, *, kickoff_tolerance: timedelta
) -> bool:
    if abs(canonical.kickoff_utc - quote.kickoff_utc) > kickoff_tolerance:
        return False
    return normalize_team_name(canonical.home) == normalize_team_name(
        quote.home
    ) and normalize_team_name(canonical.away) == normalize_team_name(quote.away)


def find_matching_provider_fixture_id(
    canonical: RawFixture,
    quotes: list[RawOddsQuote],
    *,
    kickoff_tolerance: timedelta = DEFAULT_KICKOFF_TOLERANCE,
) -> int | None:
    """The odds provider's fixture id for the quote(s) matching `canonical`.

    `quotes` is typically many market-level quotes covering many
    fixtures (one OddsProvider.fetch_odds() call returns every market for
    every fixture in a tournament) — this groups by provider_fixture_id
    first, so a fixture with 5 quotes only counts as one candidate.

    Returns None on zero matches (nothing corresponds to this fixture in
    this tournament yet — common well before kickoff) or on more than one
    match (ambiguous — refuse to guess rather than silently pick wrong).
    """
    candidates_by_id: dict[int, RawOddsQuote] = {}
    for quote in quotes:
        candidates_by_id.setdefault(quote.provider_fixture_id, quote)

    matches = [
        fixture_id
        for fixture_id, quote in candidates_by_id.items()
        if _quote_matches(canonical, quote, kickoff_tolerance=kickoff_tolerance)
    ]
    if len(matches) == 1:
        return matches[0]
    return None
