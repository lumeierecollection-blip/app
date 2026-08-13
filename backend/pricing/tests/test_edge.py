"""Tests for backend/pricing/edge.py: edge calculation and sanity gates,
against the real Pinnacle 1X2 prices from Task B1b."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from pricing.edge import evaluate_edge

REAL_PINNACLE_1X2 = {"home": 1.165, "draw": 7.66, "away": 15.44}
NOW = datetime(2026, 8, 13, 12, 0, 0, tzinfo=timezone.utc)


def test_evaluate_edge_flags_a_genuinely_better_soft_book_price():
    # Fair prob(home) from real Pinnacle data is ~0.844 (power method).
    # A soft book offering 1.30 on home (vs. fair odds ~1.185) is a real edge.
    result = evaluate_edge(
        sharp_odds=REAL_PINNACLE_1X2,
        selection="home",
        offered_odds=1.30,
        now=NOW,
        sharp_captured_at=NOW - timedelta(minutes=1),
        market_first_seen_at=NOW - timedelta(hours=1),
    )
    assert result.passed_gates is True
    assert result.rejections == []
    assert result.edge > 0.02
    assert result.flagged is True
    assert result.fair_odds == pytest.approx(1 / result.fair_probability)


def test_evaluate_edge_below_threshold_is_not_flagged():
    result = evaluate_edge(
        sharp_odds=REAL_PINNACLE_1X2,
        selection="home",
        offered_odds=1.16,  # essentially fair, no real edge
        now=NOW,
        sharp_captured_at=NOW - timedelta(minutes=1),
        market_first_seen_at=NOW - timedelta(hours=1),
    )
    assert result.passed_gates is True
    assert result.flagged is False


def test_evaluate_edge_rejects_stale_sharp_price():
    result = evaluate_edge(
        sharp_odds=REAL_PINNACLE_1X2,
        selection="home",
        offered_odds=1.30,
        now=NOW,
        sharp_captured_at=NOW - timedelta(minutes=30),
        market_first_seen_at=NOW - timedelta(hours=1),
    )
    assert result.passed_gates is False
    assert any(r.gate == "stale_price" for r in result.rejections)


def test_evaluate_edge_rejects_line_mismatch():
    result = evaluate_edge(
        sharp_odds={"over": 1.90, "under": 1.90},
        selection="over",
        offered_odds=2.20,
        now=NOW,
        sharp_captured_at=NOW - timedelta(minutes=1),
        sharp_line=2.5,
        soft_line=2.75,
        market_first_seen_at=NOW - timedelta(hours=1),
    )
    assert result.passed_gates is False
    assert any(r.gate == "line_mismatch" for r in result.rejections)


def test_evaluate_edge_accepts_matching_lines():
    result = evaluate_edge(
        sharp_odds={"over": 1.90, "under": 1.90},
        selection="over",
        offered_odds=2.20,
        now=NOW,
        sharp_captured_at=NOW - timedelta(minutes=1),
        sharp_line=2.5,
        soft_line=2.5,
        market_first_seen_at=NOW - timedelta(hours=1),
    )
    assert result.passed_gates is True


def test_evaluate_edge_rejects_suspended_market():
    result = evaluate_edge(
        sharp_odds=REAL_PINNACLE_1X2,
        selection="home",
        offered_odds=1.30,
        now=NOW,
        sharp_captured_at=NOW - timedelta(minutes=1),
        sharp_suspended=True,
        market_first_seen_at=NOW - timedelta(hours=1),
    )
    assert result.passed_gates is False
    assert any(r.gate == "suspended_market" for r in result.rejections)


def test_evaluate_edge_rejects_outlier_edge_as_likely_data_error():
    result = evaluate_edge(
        sharp_odds=REAL_PINNACLE_1X2,
        selection="away",  # fair odds ~15+ on away
        offered_odds=50.0,  # absurd -- almost certainly a data error, not a real edge
        now=NOW,
        sharp_captured_at=NOW - timedelta(minutes=1),
        market_first_seen_at=NOW - timedelta(hours=1),
    )
    assert result.passed_gates is False
    assert any(r.gate == "outlier_edge" for r in result.rejections)


def test_evaluate_edge_rejects_immature_market():
    result = evaluate_edge(
        sharp_odds=REAL_PINNACLE_1X2,
        selection="home",
        offered_odds=1.30,
        now=NOW,
        sharp_captured_at=NOW - timedelta(minutes=1),
        market_first_seen_at=NOW - timedelta(minutes=1),
    )
    assert result.passed_gates is False
    assert any(r.gate == "immature_market" for r in result.rejections)


def test_evaluate_edge_collects_every_rejection_not_just_the_first():
    result = evaluate_edge(
        sharp_odds=REAL_PINNACLE_1X2,
        selection="home",
        offered_odds=1.30,
        now=NOW,
        sharp_captured_at=NOW - timedelta(minutes=30),  # stale
        sharp_suspended=True,  # also suspended
        market_first_seen_at=NOW - timedelta(minutes=1),  # also immature
    )
    gates_hit = {r.gate for r in result.rejections}
    assert gates_hit == {"stale_price", "suspended_market", "immature_market"}


def test_evaluate_edge_unknown_selection_raises():
    with pytest.raises(ValueError):
        evaluate_edge(
            sharp_odds=REAL_PINNACLE_1X2,
            selection="not_a_real_outcome",
            offered_odds=1.30,
            now=NOW,
            sharp_captured_at=NOW - timedelta(minutes=1),
        )
