from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from scoring.strategy_scoring import (
    MIN_SAMPLE_SIZE,
    SettledSelection,
    avg_odds,
    clv_values,
    compute_returns,
    disqualifiers_for_strategy,
    gradeable,
    hit_rate,
    longest_losing_run,
    mean_clv,
    pct_positive_clv,
    point_roi,
    score_strategy,
)

NOW = datetime(2026, 8, 13, 12, 0, 0, tzinfo=timezone.utc)


def make(status, odds_used=None, days_ago=1, closing_odds=None, post_id=None) -> SettledSelection:
    return SettledSelection(
        status=status,
        odds_used=odds_used,
        settled_at=NOW - timedelta(days=days_ago),
        closing_odds=closing_odds,
        post_id=post_id,
    )


def test_gradeable_excludes_void_push_ungradeable():
    selections = [
        make("won", 2.0),
        make("lost"),
        make("void"),
        make("push"),
        make("ungradeable"),
    ]
    assert len(gradeable(selections)) == 2


def test_compute_returns_matches_the_docs_scoring_formula():
    selections = [make("won", 2.5), make("won", 1.5), make("lost")]
    returns = compute_returns(selections)
    assert returns == pytest.approx([1.5, 0.5, -1.0])


def test_point_roi_is_mean_of_returns():
    returns = [1.0, -1.0, -1.0, 2.0]
    assert point_roi(returns) == pytest.approx(0.25)


def test_point_roi_none_for_no_gradeable_bets():
    assert point_roi([]) is None


def test_hit_rate_only_counts_gradeable():
    selections = [make("won", 2.0), make("won", 2.0), make("lost"), make("void")]
    assert hit_rate(selections) == pytest.approx(2 / 3)


def test_avg_odds_over_gradeable_only():
    selections = [make("won", 2.0), make("lost", odds_used=3.0), make("void")]
    assert avg_odds(selections) == pytest.approx(2.5)


def test_longest_losing_run_counts_consecutive_losses_in_time_order():
    selections = [
        make("won", 2.0, days_ago=5),
        make("lost", days_ago=4),
        make("lost", days_ago=3),
        make("lost", days_ago=2),
        make("won", 2.0, days_ago=1),
    ]
    assert longest_losing_run(selections) == 3


def test_longest_losing_run_zero_when_no_losses():
    assert longest_losing_run([make("won", 2.0)]) == 0


def test_clv_values_skips_selections_without_a_closing_line():
    selections = [
        make("won", 2.0, closing_odds=1.8),  # CLV = 2.0/1.8 - 1 = 0.111
        make("lost", closing_odds=None),  # excluded, no closing line captured
        make("won", 1.5, closing_odds=1.6),  # negative CLV
    ]
    values = clv_values(selections)
    assert len(values) == 2
    assert values[0] == pytest.approx(2.0 / 1.8 - 1)


def test_mean_and_pct_positive_clv():
    selections = [
        make("won", 2.0, closing_odds=1.8),  # positive CLV
        make("lost", odds_used=1.5, closing_odds=1.6),  # negative CLV -- lost bets have CLV too
    ]
    # clv_values only uses odds_used, present on both here
    assert mean_clv(selections) is not None
    pct = pct_positive_clv(selections)
    assert pct == pytest.approx(0.5)


def test_mean_clv_none_with_no_closing_lines():
    assert mean_clv([make("won", 2.0)]) is None


def test_disqualifiers_no_op_for_pure_odds_market_selections():
    selections = [make("won", 2.0), make("lost")]
    assert disqualifiers_for_strategy(selections) == []


def test_disqualifiers_raises_for_unhandled_social_origin_selections():
    selections = [make("won", 2.0, post_id="some-post-id")]
    with pytest.raises(NotImplementedError):
        disqualifiers_for_strategy(selections)


def test_score_strategy_unrated_under_fifty_samples():
    selections = [make("won", 2.0, days_ago=i) for i in range(10)]
    result = score_strategy(selections, now=NOW)
    assert result.n_settled == 10
    assert result.rated is False


def test_score_strategy_rated_at_fifty_samples():
    selections = [make("won", 2.0, days_ago=i) for i in range(MIN_SAMPLE_SIZE)]
    result = score_strategy(selections, now=NOW)
    assert result.n_settled == MIN_SAMPLE_SIZE
    assert result.rated is True
    assert result.roi == pytest.approx(1.0)  # every bet won at odds 2.0 -> return of 1.0 each
    assert result.roi_ci_low is not None and result.roi_ci_high is not None


def test_score_strategy_excludes_void_and_push_from_sample_gate():
    # 50 winners plus 20 voids/pushes -- the voids must not count toward
    # n_settled or dilute the sample-gate threshold.
    selections = [make("won", 2.0, days_ago=i) for i in range(MIN_SAMPLE_SIZE)]
    selections += [make("void", days_ago=i) for i in range(10)]
    selections += [make("push", days_ago=i) for i in range(10)]
    result = score_strategy(selections, now=NOW)
    assert result.n_settled == MIN_SAMPLE_SIZE
