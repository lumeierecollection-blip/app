"""Sanity gates and edge calculation (Task B3, docs/ARCHITECTURE.md §
"Fair price and value detection"). Every gate rejection carries a reason
-- silently dropping a selection with no logged reason is exactly the
kind of failure this project's ingestion_health design already refuses
to allow elsewhere in the pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .devig import devig
from .devig import fair_odds as _fair_odds

DEFAULT_MAX_STALENESS = timedelta(minutes=5)
DEFAULT_MIN_MARKET_AGE = timedelta(minutes=10)
DEFAULT_MAX_SANE_EDGE = 0.25  # 25%; above this, assume a data error, not a real opportunity
DEFAULT_EDGE_THRESHOLD = 0.02  # 2%, a setting per Task B3, not a hardcoded constant


@dataclass
class GateRejection:
    gate: str
    reason: str


@dataclass
class EdgeEvaluation:
    fair_probability: float
    fair_odds: float
    edge: float
    passed_gates: bool
    rejections: list[GateRejection] = field(default_factory=list)
    flagged: bool = False  # passed every gate AND edge exceeds the configured threshold


def check_staleness(
    captured_at: datetime, now: datetime, max_staleness: timedelta = DEFAULT_MAX_STALENESS
) -> GateRejection | None:
    age = now - captured_at
    if age > max_staleness:
        return GateRejection("stale_price", f"sharp price captured {age} ago, exceeds max staleness {max_staleness}")
    return None


def check_line_match(sharp_line: float | None, soft_line: float | None) -> GateRejection | None:
    if sharp_line != soft_line:
        return GateRejection("line_mismatch", f"sharp line {sharp_line!r} != soft line {soft_line!r}")
    return None


def check_not_suspended(sharp_suspended: bool, soft_suspended: bool) -> GateRejection | None:
    if sharp_suspended or soft_suspended:
        return GateRejection("suspended_market", "sharp or soft book market is suspended")
    return None


def check_sane_edge(edge: float, max_sane_edge: float = DEFAULT_MAX_SANE_EDGE) -> GateRejection | None:
    if edge > max_sane_edge:
        return GateRejection(
            "outlier_edge", f"edge {edge:.1%} exceeds max sane edge {max_sane_edge:.1%} -- likely a data error"
        )
    return None


def check_market_maturity(
    first_seen_at: datetime, now: datetime, min_market_age: timedelta = DEFAULT_MIN_MARKET_AGE
) -> GateRejection | None:
    age = now - first_seen_at
    if age < min_market_age:
        return GateRejection("immature_market", f"market only {age} old, under minimum {min_market_age}")
    return None


def evaluate_edge(
    *,
    sharp_odds: dict[str, float],
    selection: str,
    offered_odds: float,
    now: datetime,
    sharp_captured_at: datetime,
    sharp_line: float | None = None,
    soft_line: float | None = None,
    sharp_suspended: bool = False,
    soft_suspended: bool = False,
    market_first_seen_at: datetime | None = None,
    edge_threshold: float = DEFAULT_EDGE_THRESHOLD,
    max_staleness: timedelta = DEFAULT_MAX_STALENESS,
    max_sane_edge: float = DEFAULT_MAX_SANE_EDGE,
    min_market_age: timedelta = DEFAULT_MIN_MARKET_AGE,
) -> EdgeEvaluation:
    """De-vig the sharp book's prices, compute the edge of `offered_odds`
    on `selection`, and run every sanity gate -- collecting every
    rejection rather than stopping at the first, so the logged reason is
    always complete."""
    fair_probs = devig(sharp_odds)
    if selection not in fair_probs:
        raise ValueError(f"selection {selection!r} not found in sharp_odds outcomes {list(sharp_odds)}")
    prob = fair_probs[selection]
    odds = _fair_odds(prob)
    edge = offered_odds * prob - 1.0

    rejections: list[GateRejection] = []
    for check in (
        check_staleness(sharp_captured_at, now, max_staleness),
        check_line_match(sharp_line, soft_line),
        check_not_suspended(sharp_suspended, soft_suspended),
        check_sane_edge(edge, max_sane_edge),
    ):
        if check is not None:
            rejections.append(check)
    if market_first_seen_at is not None:
        maturity = check_market_maturity(market_first_seen_at, now, min_market_age)
        if maturity is not None:
            rejections.append(maturity)

    passed = not rejections
    flagged = passed and edge > edge_threshold
    return EdgeEvaluation(
        fair_probability=prob,
        fair_odds=odds,
        edge=edge,
        passed_gates=passed,
        rejections=rejections,
        flagged=flagged,
    )
