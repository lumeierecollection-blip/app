from __future__ import annotations

import pytest

from scoring.stats import bootstrap_ci, decay_weight, wilson_interval


def test_wilson_interval_wide_for_small_sample():
    lo, hi = wilson_interval(wins=1, n=2)
    assert 0.0 <= lo < 0.5 < hi <= 1.0
    assert (hi - lo) > 0.4  # small samples must stay wide, not falsely confident


def test_wilson_interval_narrows_with_more_data_same_rate():
    lo_small, hi_small = wilson_interval(wins=5, n=10)
    lo_big, hi_big = wilson_interval(wins=500, n=1000)
    assert (hi_big - lo_big) < (hi_small - lo_small)


def test_wilson_interval_perfect_record_has_a_lower_bound_below_one():
    # The Wilson interval's upper bound algebraically simplifies to
    # exactly 1.0 when p=1 (center + margin = 1 + z^2/n, divided by the
    # same 1 + z^2/n) -- that's correct math, not overconfidence. The
    # meaningful check for "don't claim certainty from a finite sample"
    # is the *lower* bound staying well below 1.
    lo, hi = wilson_interval(wins=10, n=10)
    assert hi == pytest.approx(1.0)
    assert lo < 0.8


def test_wilson_interval_rejects_invalid_input():
    with pytest.raises(ValueError):
        wilson_interval(wins=0, n=0)
    with pytest.raises(ValueError):
        wilson_interval(wins=11, n=10)


def test_decay_weight_at_zero_days_is_one():
    assert decay_weight(0, half_life_days=45.0) == pytest.approx(1.0)


def test_decay_weight_at_half_life_is_one_half():
    assert decay_weight(45.0, half_life_days=45.0) == pytest.approx(0.5)


def test_decay_weight_at_two_half_lives_is_one_quarter():
    assert decay_weight(90.0, half_life_days=45.0) == pytest.approx(0.25)


def test_decay_weight_clamps_negative_elapsed_to_full_weight():
    assert decay_weight(-5.0, half_life_days=45.0) == pytest.approx(1.0)


def test_bootstrap_ci_brackets_the_true_mean_for_a_known_distribution():
    values = [1.0] * 60 + [-1.0] * 40  # mean = 0.2
    lo, hi = bootstrap_ci(values, resamples=2000, seed=42)
    assert lo < 0.2 < hi


def test_bootstrap_ci_is_narrower_for_larger_samples():
    small = [1.0] * 6 + [-1.0] * 4  # mean 0.2, n=10
    large = [1.0] * 600 + [-1.0] * 400  # mean 0.2, n=1000
    lo_s, hi_s = bootstrap_ci(small, resamples=2000, seed=1)
    lo_l, hi_l = bootstrap_ci(large, resamples=2000, seed=1)
    assert (hi_l - lo_l) < (hi_s - lo_s)


def test_bootstrap_ci_is_deterministic_with_a_seed():
    values = [1.0, -1.0, 0.5, -1.0, 2.0]
    first = bootstrap_ci(values, resamples=500, seed=7)
    second = bootstrap_ci(values, resamples=500, seed=7)
    assert first == second


def test_bootstrap_ci_weights_bias_toward_higher_weighted_values():
    # All +1 except one -1 with a huge weight -- a heavily-weighted
    # resampling should pull the mean down toward the weighted outcome.
    values = [1.0] * 10 + [-1.0]
    weights = [1.0] * 10 + [1000.0]
    lo, hi = bootstrap_ci(values, weights=weights, resamples=2000, seed=3)
    assert hi < 0.5  # heavily pulled toward -1, not the unweighted mean (~0.82)


def test_bootstrap_ci_rejects_empty_sample():
    with pytest.raises(ValueError):
        bootstrap_ci([])
