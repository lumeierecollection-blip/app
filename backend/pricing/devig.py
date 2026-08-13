"""De-vigging: convert a sharp book's raw odds into fair (true)
probabilities.

Two-way markets (over/under, BTTS) use multiplicative de-vigging: each
implied probability is divided by the sum of all implied probabilities
in the market. This is fine for two-way markets.

Three-way markets (1X2) use the power method instead. Multiplicative
de-vigging is biased for 1X2 -- it systematically overprices longshots,
because a draw or big underdog absorbs more of the vig proportionally
than its true probability would justify (docs/ARCHITECTURE.md § "Fair
price and value detection", Task B3). The power method solves for a
single exponent k such that raising every raw implied probability to the
k-th power makes them sum to 1; because p**k shrinks small (longshot)
probabilities more than large (favorite) ones in relative terms, it
corrects the same favorite-longshot bias Shin's method targets. Chosen
over Shin's method specifically because Shin's method requires solving
an implicit equation for an "insider trading fraction" z with its own
numerical-stability edge cases, while the power method's target function
(sum of p_i**k over k) is strictly monotonic in k for any k in three-way
market, so plain bisection always converges to a unique root -- simpler
and just as effective at the same bias correction.
"""

from __future__ import annotations


def implied_probability(odds: float) -> float:
    if odds <= 1.0:
        raise ValueError(f"odds must be > 1.0, got {odds}")
    return 1.0 / odds


def fair_odds(probability: float) -> float:
    if not 0 < probability < 1:
        raise ValueError(f"probability must be strictly between 0 and 1, got {probability}")
    return 1.0 / probability


def multiplicative_devig(odds: dict[str, float]) -> dict[str, float]:
    """Fair probabilities for a two-way market."""
    if len(odds) < 2:
        raise ValueError("need at least two outcomes to de-vig a market")
    implied = {k: implied_probability(v) for k, v in odds.items()}
    total = sum(implied.values())
    if total <= 0:
        raise ValueError("implied probabilities sum to zero or less")
    return {k: v / total for k, v in implied.items()}


def power_devig(odds: dict[str, float], tolerance: float = 1e-10, max_iterations: int = 200) -> dict[str, float]:
    """Fair probabilities for a three-way (1X2) market via the power method."""
    if len(odds) != 3:
        raise ValueError(f"power_devig is for three-way (1X2) markets, got {len(odds)} outcomes")
    implied = {k: implied_probability(v) for k, v in odds.items()}
    values = list(implied.values())

    def total_at(k: float) -> float:
        return sum(p**k for p in values)

    lo, hi = 1e-9, 2.0
    while total_at(hi) > 1.0:
        hi *= 2
        if hi > 1e6:
            raise ValueError("power method failed to converge for input odds -- check for bad data")

    mid = hi
    for _ in range(max_iterations):
        mid = (lo + hi) / 2
        total = total_at(mid)
        if abs(total - 1.0) < tolerance:
            break
        if total > 1.0:
            lo = mid
        else:
            hi = mid

    return {key: p**mid for key, p in implied.items()}


def devig(odds: dict[str, float]) -> dict[str, float]:
    """Dispatch to the right de-vig method by market shape: two outcomes ->
    multiplicative, three outcomes (1X2) -> power method. Other outcome
    counts aren't a market shape this project prices yet."""
    if len(odds) == 2:
        return multiplicative_devig(odds)
    if len(odds) == 3:
        return power_devig(odds)
    raise ValueError(f"devig only supports two-way or three-way (1X2) markets, got {len(odds)} outcomes")
