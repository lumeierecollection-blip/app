"""Tests for backend/pricing/devig.py, including against the real Pinnacle
1X2 prices captured in fixtures/provider_probes/oddspapi_odds_pinnacle.json
(Task B1b) -- home 1.165 / draw 7.66 / away 15.44 -- not just synthetic
numbers.
"""

from __future__ import annotations

import pytest

from pricing.devig import devig, fair_odds, implied_probability, multiplicative_devig, power_devig

REAL_PINNACLE_1X2 = {"home": 1.165, "draw": 7.66, "away": 15.44}


def test_implied_probability():
    assert implied_probability(2.0) == pytest.approx(0.5)
    assert implied_probability(1.165) == pytest.approx(1 / 1.165)


def test_implied_probability_rejects_odds_at_or_below_one():
    with pytest.raises(ValueError):
        implied_probability(1.0)
    with pytest.raises(ValueError):
        implied_probability(0.5)


def test_fair_odds_is_inverse_of_probability():
    assert fair_odds(0.5) == pytest.approx(2.0)
    assert fair_odds(0.25) == pytest.approx(4.0)


def test_fair_odds_rejects_out_of_range_probability():
    with pytest.raises(ValueError):
        fair_odds(0.0)
    with pytest.raises(ValueError):
        fair_odds(1.0)


def test_multiplicative_devig_two_way_removes_the_overround():
    # A symmetric two-way market at 1.90/1.90 has raw implied probabilities
    # of 0.5263 each, summing to 1.0526 (5.26% overround). De-vigged, they
    # should land exactly at 0.5/0.5.
    fair = multiplicative_devig({"over": 1.90, "under": 1.90})
    assert fair["over"] == pytest.approx(0.5)
    assert fair["under"] == pytest.approx(0.5)
    assert sum(fair.values()) == pytest.approx(1.0)


def test_multiplicative_devig_asymmetric_two_way():
    fair = multiplicative_devig({"yes": 1.50, "no": 2.80})
    assert sum(fair.values()) == pytest.approx(1.0)
    assert fair["yes"] > fair["no"]


def test_multiplicative_devig_requires_at_least_two_outcomes():
    with pytest.raises(ValueError):
        multiplicative_devig({"only": 1.5})


def test_power_devig_real_pinnacle_1x2_sums_to_one():
    fair = power_devig(REAL_PINNACLE_1X2)
    assert sum(fair.values()) == pytest.approx(1.0, abs=1e-8)
    # Ordering must be preserved: home is the clear favorite.
    assert fair["home"] > fair["draw"] > fair["away"]


def test_power_devig_corrects_favorite_longshot_bias_vs_multiplicative():
    """The whole reason Task B3 rules out plain multiplicative de-vigging
    for 1X2 markets: it overprices longshots. The power method must shift
    probability mass from draw/away back toward the favorite relative to
    multiplicative de-vigging on the same real market."""
    power_fair = power_devig(REAL_PINNACLE_1X2)
    mult_fair = multiplicative_devig(REAL_PINNACLE_1X2)

    assert power_fair["home"] > mult_fair["home"]
    assert power_fair["draw"] < mult_fair["draw"]
    assert power_fair["away"] < mult_fair["away"]


def test_power_devig_requires_exactly_three_outcomes():
    with pytest.raises(ValueError):
        power_devig({"a": 1.5, "b": 2.5})


def test_power_devig_handles_near_certain_favorite_without_diverging():
    # A near-certain favorite (odds close to 1.0) is a real numerical edge
    # case for the bisection search's upper bound.
    fair = power_devig({"home": 1.01, "draw": 21.0, "away": 41.0})
    assert sum(fair.values()) == pytest.approx(1.0, abs=1e-6)
    assert 0 < fair["home"] < 1


def test_devig_dispatches_two_way_to_multiplicative():
    fair = devig({"over": 1.90, "under": 1.90})
    assert fair == pytest.approx(multiplicative_devig({"over": 1.90, "under": 1.90}))


def test_devig_dispatches_three_way_to_power_method():
    fair = devig(REAL_PINNACLE_1X2)
    assert fair == pytest.approx(power_devig(REAL_PINNACLE_1X2))


def test_devig_rejects_unsupported_outcome_counts():
    with pytest.raises(ValueError):
        devig({"a": 1.5, "b": 2.0, "c": 3.0, "d": 4.0})
