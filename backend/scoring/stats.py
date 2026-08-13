"""Generic statistics used by strategy scoring (Task B5): the Wilson
score interval for win-rate confidence, a weighted bootstrap for the ROI
confidence interval, and exponential recency decay. No numpy -- the
stack table doesn't list it, and Python's own `random`/`statistics`
modules are enough at this data volume.
"""

from __future__ import annotations

import random

Z_95 = 1.959963985  # two-sided 95% normal quantile


def wilson_interval(wins: int, n: int, z: float = Z_95) -> tuple[float, float]:
    """Wilson score interval on a win rate -- narrower and better-behaved
    near 0/1 than a naive normal approximation, which is why docs/SCORING.md
    specifies it by name rather than "a confidence interval"."""
    if n <= 0:
        raise ValueError("n must be positive")
    if not 0 <= wins <= n:
        raise ValueError(f"wins ({wins}) must be between 0 and n ({n})")
    p = wins / n
    denom = 1 + z**2 / n
    center = (p + z**2 / (2 * n)) / denom
    margin = (z * ((p * (1 - p) / n + z**2 / (4 * n**2)) ** 0.5)) / denom
    return max(0.0, center - margin), min(1.0, center + margin)


def decay_weight(days_elapsed: float, half_life_days: float = 45.0) -> float:
    """Recency weight, half-life ~45 days (docs/SCORING.md §7 "Decay").
    A result from today has weight 1.0; one 45 days old has weight 0.5."""
    if days_elapsed < 0:
        days_elapsed = 0.0
    return 0.5 ** (days_elapsed / half_life_days)


def bootstrap_ci(
    values: list[float],
    *,
    weights: list[float] | None = None,
    resamples: int = 2000,
    low_percentile: float = 5.0,
    high_percentile: float = 95.0,
    seed: int | None = None,
) -> tuple[float, float]:
    """Bootstrap confidence interval on the mean of `values`, resampling
    with replacement `resamples` times and taking the requested
    percentiles of the resampled means (docs/SCORING.md §7: "resample
    settled selections 2000x, take 5th/95th percentile").

    `weights` (same length as `values`), if given, bias the resampling
    toward higher-weighted (more recent, via `decay_weight`) observations
    -- this is where recency decay enters the ROI confidence interval;
    the *point* ROI formula itself stays the unweighted mean specified
    verbatim in docs/SCORING.md.
    """
    if not values:
        raise ValueError("cannot bootstrap an empty sample")
    rng = random.Random(seed)
    n = len(values)
    means = []
    for _ in range(resamples):
        sample = rng.choices(values, weights=weights, k=n)
        means.append(sum(sample) / n)
    means.sort()

    def percentile(pct: float) -> float:
        if len(means) == 1:
            return means[0]
        rank = (pct / 100.0) * (len(means) - 1)
        lo_idx = int(rank)
        hi_idx = min(lo_idx + 1, len(means) - 1)
        frac = rank - lo_idx
        return means[lo_idx] + (means[hi_idx] - means[lo_idx]) * frac

    return percentile(low_percentile), percentile(high_percentile)
