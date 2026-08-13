/**
 * De-vigging: convert a sharp book's raw odds into fair (true)
 * probabilities. Ported from the Python implementation (backend/pricing/devig.py
 * in this project's history, Task B3) -- same math, same reasoning, JS instead
 * of Python (Prompt 8: backend rewritten to match tradeapp/server's plain
 * Node.js shape).
 *
 * Two-way markets (over/under, BTTS) use multiplicative de-vigging: each
 * implied probability is divided by the sum of all implied probabilities in
 * the market. This is fine for two-way markets.
 *
 * Three-way markets (1X2) use the power method instead. Multiplicative
 * de-vigging is biased for 1X2 -- it systematically overprices longshots,
 * because a draw or big underdog absorbs more of the vig proportionally than
 * its true probability would justify. The power method solves for a single
 * exponent k such that raising every raw implied probability to the k-th
 * power makes them sum to 1; because p**k shrinks small (longshot)
 * probabilities more than large (favorite) ones in relative terms, it
 * corrects the same favorite-longshot bias Shin's method targets. Chosen over
 * Shin's method specifically because Shin's method requires solving an
 * implicit equation for an "insider trading fraction" z with its own
 * numerical-stability edge cases, while the power method's target function
 * (sum of p_i**k over k) is strictly monotonic in k for a three-way market,
 * so plain bisection always converges to a unique root -- simpler and just as
 * effective at the same bias correction.
 */

export function impliedProbability(odds) {
  if (odds <= 1.0) {
    throw new Error(`odds must be > 1.0, got ${odds}`);
  }
  return 1.0 / odds;
}

export function fairOdds(probability) {
  if (!(probability > 0 && probability < 1)) {
    throw new Error(`probability must be strictly between 0 and 1, got ${probability}`);
  }
  return 1.0 / probability;
}

export function multiplicativeDevig(odds) {
  const keys = Object.keys(odds);
  if (keys.length < 2) {
    throw new Error('need at least two outcomes to de-vig a market');
  }
  const implied = {};
  for (const k of keys) implied[k] = impliedProbability(odds[k]);
  const total = Object.values(implied).reduce((a, b) => a + b, 0);
  if (total <= 0) {
    throw new Error('implied probabilities sum to zero or less');
  }
  const fair = {};
  for (const k of keys) fair[k] = implied[k] / total;
  return fair;
}

export function powerDevig(odds, tolerance = 1e-10, maxIterations = 200) {
  const keys = Object.keys(odds);
  if (keys.length !== 3) {
    throw new Error(`powerDevig is for three-way (1X2) markets, got ${keys.length} outcomes`);
  }
  const implied = {};
  for (const k of keys) implied[k] = impliedProbability(odds[k]);
  const values = Object.values(implied);

  const totalAt = (k) => values.reduce((sum, p) => sum + p ** k, 0);

  let lo = 1e-9;
  let hi = 2.0;
  while (totalAt(hi) > 1.0) {
    hi *= 2;
    if (hi > 1e6) {
      throw new Error('power method failed to converge for input odds -- check for bad data');
    }
  }

  let mid = hi;
  for (let i = 0; i < maxIterations; i++) {
    mid = (lo + hi) / 2;
    const total = totalAt(mid);
    if (Math.abs(total - 1.0) < tolerance) break;
    if (total > 1.0) lo = mid;
    else hi = mid;
  }

  const fair = {};
  for (const k of keys) fair[k] = implied[k] ** mid;
  return fair;
}

/**
 * Dispatch to the right de-vig method by market shape: two outcomes ->
 * multiplicative, three outcomes (1X2) -> power method. Other outcome
 * counts aren't a market shape this project prices yet.
 */
export function devig(odds) {
  const count = Object.keys(odds).length;
  if (count === 2) return multiplicativeDevig(odds);
  if (count === 3) return powerDevig(odds);
  throw new Error(`devig only supports two-way or three-way (1X2) markets, got ${count} outcomes`);
}
