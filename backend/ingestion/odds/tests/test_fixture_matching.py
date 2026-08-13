from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from ingestion.odds.fixture_matching import (
    find_matching_provider_fixture_id,
    normalize_team_name,
)
from ingestion.odds.models import RawFixture, RawOddsQuote

KICKOFF = datetime(2026, 8, 21, 19, 0, tzinfo=timezone.utc)


def _quote(provider_fixture_id, home, away, kickoff=KICKOFF, **overrides):
    defaults = dict(
        provider_fixture_id=provider_fixture_id,
        home=home,
        away=away,
        kickoff_utc=kickoff,
        bookmaker="pinnacle",
        market="h2h",
        selection="home",
        line=None,
        odds=1.9,
    )
    defaults.update(overrides)
    return RawOddsQuote(**defaults)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Manchester United", "manchester united"),
        ("Man Utd", "manchester united"),
        ("Man United", "manchester united"),
        ("Tottenham Hotspur FC", "tottenham hotspur"),
        ("Spurs", "tottenham hotspur"),
        ("Nott'm Forest", "nottingham forest"),
        ("Brighton & Hove Albion", "brighton and hove albion"),
        ("Wolves", "wolverhampton wanderers"),
    ],
)
def test_normalize_team_name_resolves_known_aliases(raw, expected):
    assert normalize_team_name(raw) == expected


def test_normalize_team_name_is_idempotent_on_already_canonical_names():
    assert normalize_team_name("Liverpool") == "liverpool"
    assert normalize_team_name("liverpool") == "liverpool"


def test_find_match_succeeds_on_exact_name_and_kickoff():
    canonical = RawFixture(
        provider_fixture_id=1, competition="Premier League",
        home="Manchester United", away="Liverpool", kickoff_utc=KICKOFF,
    )
    quotes = [_quote(555, "Manchester United", "Liverpool")]
    assert find_matching_provider_fixture_id(canonical, quotes) == 555


def test_find_match_succeeds_through_alias_and_suffix_normalization():
    canonical = RawFixture(
        provider_fixture_id=1, competition="Premier League",
        home="Man Utd", away="Spurs", kickoff_utc=KICKOFF,
    )
    quotes = [_quote(555, "Manchester United FC", "Tottenham Hotspur")]
    assert find_matching_provider_fixture_id(canonical, quotes) == 555


def test_find_match_tolerates_small_kickoff_drift_between_providers():
    canonical = RawFixture(
        provider_fixture_id=1, competition="Premier League",
        home="Arsenal", away="Chelsea", kickoff_utc=KICKOFF,
    )
    quotes = [_quote(555, "Arsenal", "Chelsea", kickoff=KICKOFF + timedelta(minutes=30))]
    assert find_matching_provider_fixture_id(canonical, quotes) == 555


def test_find_match_rejects_kickoff_drift_beyond_tolerance():
    canonical = RawFixture(
        provider_fixture_id=1, competition="Premier League",
        home="Arsenal", away="Chelsea", kickoff_utc=KICKOFF,
    )
    quotes = [_quote(555, "Arsenal", "Chelsea", kickoff=KICKOFF + timedelta(hours=6))]
    assert find_matching_provider_fixture_id(canonical, quotes) is None


def test_find_match_returns_none_when_nothing_matches():
    canonical = RawFixture(
        provider_fixture_id=1, competition="Premier League",
        home="Arsenal", away="Chelsea", kickoff_utc=KICKOFF,
    )
    quotes = [_quote(555, "Manchester United", "Liverpool")]
    assert find_matching_provider_fixture_id(canonical, quotes) is None


def test_find_match_refuses_to_guess_when_ambiguous():
    """Two different odds-provider fixtures both look like a match --
    must return None rather than silently picking one."""
    canonical = RawFixture(
        provider_fixture_id=1, competition="Premier League",
        home="Arsenal", away="Chelsea", kickoff_utc=KICKOFF,
    )
    quotes = [
        _quote(555, "Arsenal", "Chelsea", kickoff=KICKOFF),
        _quote(556, "Arsenal", "Chelsea", kickoff=KICKOFF + timedelta(minutes=5)),
    ]
    assert find_matching_provider_fixture_id(canonical, quotes) is None


def test_find_match_groups_many_quotes_per_fixture_as_one_candidate():
    """fetch_odds() returns one quote per market/selection -- 5+ rows for
    a single fixture (h2h x3, totals x2). Matching must not multi-count
    them as separate candidates and falsely detect ambiguity."""
    canonical = RawFixture(
        provider_fixture_id=1, competition="Premier League",
        home="Arsenal", away="Chelsea", kickoff_utc=KICKOFF,
    )
    quotes = [
        _quote(555, "Arsenal", "Chelsea", selection="home", odds=1.9),
        _quote(555, "Arsenal", "Chelsea", selection="draw", odds=3.6),
        _quote(555, "Arsenal", "Chelsea", selection="away", odds=4.2),
        _quote(555, "Arsenal", "Chelsea", market="totals", selection="over", line=2.5, odds=1.95),
    ]
    assert find_matching_provider_fixture_id(canonical, quotes) == 555
