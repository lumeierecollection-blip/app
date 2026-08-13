"""Task B5 -- strategy scoring, repointed from tipster accounts to
strategies per docs/SCORING.md's Amendment B5 addendum. Same engine as
the verbatim §7 (ROI, Wilson/bootstrap CIs, roi_ci_low ranking, the
50-sample gate, decay), with CLV added as the headline metric.

**Void/push handling, a judgment call the brief doesn't spell out:**
void and push settlements refund the stake (no P&L, no signal on
whether the price was right) so they're excluded from both the ROI
numerator/denominator and the 50-sample gate -- counting them would
dilute a strategy's sample toward selections that never actually tested
its edge. `ungradeable` selections are excluded from everywhere for the
same reason (docs/ARCHITECTURE.md § "Settlement": "never guess a
settlement").

**Disqualifiers, per docs/SCORING.md §7:** deleted-post rate, post-kickoff
capture rate, claimed-odds inflation, and "posted after the result was
known" are all about a *post* -- they have no meaning for `auto_odds`/
`manual_check` selections, which have no post and no claimed-vs-verified
gap (the price taken is always the price recorded, live). They stay
defined for whenever social-origin selections feed into strategy-style
scoring, and are a guaranteed no-op for the odds-market path today --
see `disqualifiers_for_strategy` below, not silently dropped.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .stats import bootstrap_ci, decay_weight

MIN_SAMPLE_SIZE = 50
GRADEABLE_STATUSES = ("won", "lost")


@dataclass
class SettledSelection:
    status: str  # 'won' | 'lost' | 'void' | 'push' | 'ungradeable'
    odds_used: float | None
    settled_at: datetime
    closing_odds: float | None = None
    post_id: str | None = None
    payout_fraction: float = 1.0  # < 1.0 only for quarter-line AH/totals half win/half loss (Task B6)


def gradeable(selections: list[SettledSelection]) -> list[SettledSelection]:
    return [s for s in selections if s.status in GRADEABLE_STATUSES]


def compute_returns(selections: list[SettledSelection]) -> list[float]:
    """odds_used - 1 for a win, -1 for a loss -- the exact §7 formula,
    scaled by payout_fraction for a quarter-line half win/half loss
    (Task B6) -- a full win/loss has payout_fraction 1.0 and this is a
    no-op for every other market."""
    returns = []
    for s in selections:
        if s.status == "won":
            if s.odds_used is None:
                raise ValueError("a won selection must have odds_used set")
            returns.append((s.odds_used - 1.0) * s.payout_fraction)
        elif s.status == "lost":
            returns.append(-1.0 * s.payout_fraction)
    return returns


def point_roi(returns: list[float]) -> float | None:
    if not returns:
        return None
    return sum(returns) / len(returns)


def hit_rate(selections: list[SettledSelection]) -> float | None:
    g = gradeable(selections)
    if not g:
        return None
    wins = sum(1 for s in g if s.status == "won")
    return wins / len(g)


def avg_odds(selections: list[SettledSelection]) -> float | None:
    odds = [s.odds_used for s in gradeable(selections) if s.odds_used is not None]
    if not odds:
        return None
    return sum(odds) / len(odds)


def longest_losing_run(selections: list[SettledSelection]) -> int:
    ordered = sorted(gradeable(selections), key=lambda s: s.settled_at)
    longest = current = 0
    for s in ordered:
        if s.status == "lost":
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def clv_values(selections: list[SettledSelection]) -> list[float]:
    """CLV = (odds_taken / closing_odds) - 1, per docs/SCORING.md
    Amendment B5. closing_odds is the sharp book's closing-line price for
    the same fixture/market/selection -- missing for a selection whose
    fixture hasn't kicked off yet, or whose closing line was never
    captured; both are excluded here rather than treated as zero CLV."""
    values = []
    for s in gradeable(selections):
        if s.odds_used is not None and s.closing_odds is not None and s.closing_odds > 1.0:
            values.append(s.odds_used / s.closing_odds - 1.0)
    return values


def mean_clv(selections: list[SettledSelection]) -> float | None:
    values = clv_values(selections)
    if not values:
        return None
    return sum(values) / len(values)


def pct_positive_clv(selections: list[SettledSelection]) -> float | None:
    values = clv_values(selections)
    if not values:
        return None
    return sum(1 for v in values if v > 0) / len(values)


def disqualifiers_for_strategy(selections: list[SettledSelection]) -> list[str]:
    """The §7 disqualifiers are all defined in terms of a *post* (deleted
    rate, post-kickoff capture rate, claimed-vs-verified odds inflation,
    posted-after-result). `auto_odds`/`manual_check` selections have no
    post_id, so none of them can trigger -- this returns [] for exactly
    that reason, not because the checks were skipped. Selections that do
    carry a post_id (social origin, once re-enabled) would need the
    actual post metadata (deleted_detected_at, captured_at vs kickoff,
    claimed_odds vs verified_odds) wired in here; that data isn't
    available from a SettledSelection alone yet."""
    if any(s.post_id is not None for s in selections):
        raise NotImplementedError(
            "social-origin selections found but post-based disqualifier checks aren't wired up yet "
            "-- the deferred social path (sources.social.enabled) isn't re-enabled"
        )
    return []


@dataclass
class StrategyScoreResult:
    n_settled: int
    roi: float | None
    roi_ci_low: float | None
    roi_ci_high: float | None
    hit_rate: float | None
    avg_odds: float | None
    mean_clv: float | None
    pct_positive_clv: float | None
    longest_losing_run: int
    rated: bool  # False => UNRATED (n_settled < 50), cannot contribute to a slip
    disqualified: bool
    disqualification_reasons: list[str]


def score_strategy(
    selections: list[SettledSelection],
    *,
    now: datetime,
    half_life_days: float = 45.0,
    resamples: int = 2000,
    seed: int | None = None,
) -> StrategyScoreResult:
    disqualification_reasons = disqualifiers_for_strategy(selections)
    g = gradeable(selections)
    n = len(g)
    returns = compute_returns(g)
    roi = point_roi(returns)

    roi_ci_low = roi_ci_high = None
    if returns:
        weights = [decay_weight((now - s.settled_at).days, half_life_days) for s in g if s.status in GRADEABLE_STATUSES]
        roi_ci_low, roi_ci_high = bootstrap_ci(returns, weights=weights, resamples=resamples, seed=seed)

    return StrategyScoreResult(
        n_settled=n,
        roi=roi,
        roi_ci_low=roi_ci_low,
        roi_ci_high=roi_ci_high,
        hit_rate=hit_rate(g),
        avg_odds=avg_odds(g),
        mean_clv=mean_clv(g),
        pct_positive_clv=pct_positive_clv(g),
        longest_losing_run=longest_losing_run(g),
        rated=n >= MIN_SAMPLE_SIZE,
        disqualified=bool(disqualification_reasons),
        disqualification_reasons=disqualification_reasons,
    )
