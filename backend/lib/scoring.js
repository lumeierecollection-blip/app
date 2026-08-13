/**
 * Task B5 -- strategy scoring, ported from backend/scoring/stats.py and
 * strategy_scoring.py in this project's history. Same engine as
 * docs/SCORING.md's verbatim §7 (ROI, Wilson/bootstrap CIs, roi_ci_low
 * ranking, the 50-sample gate, decay), with CLV added as the headline
 * metric per the Amendment B5 addendum.
 *
 * **Void/push handling, a judgment call the brief doesn't spell out:**
 * void and push settlements refund the stake (no P&L, no signal on whether
 * the price was right) so they're excluded from both the ROI
 * numerator/denominator and the 50-sample gate -- counting them would
 * dilute a strategy's sample toward selections that never actually tested
 * its edge. `ungradeable` selections are excluded for the same reason.
 *
 * **Disqualifiers** (deleted-post rate, post-kickoff capture rate, claimed
 * odds inflation, posted-after-result) are all defined in terms of a
 * *post* -- they have no meaning for `auto_odds`/`manual_check` selections,
 * which have no post and no claimed-vs-verified gap. They stay defined for
 * whenever social-origin selections feed into strategy-style scoring, and
 * are a guaranteed no-op for the odds-market path today.
 */

const Z_95 = 1.959963985; // two-sided 95% normal quantile

/** Wilson score interval on a win rate -- narrower and better-behaved near
 * 0/1 than a naive normal approximation. */
export function wilsonInterval(wins, n, z = Z_95) {
  if (n <= 0) throw new Error('n must be positive');
  if (!(wins >= 0 && wins <= n)) throw new Error(`wins (${wins}) must be between 0 and n (${n})`);
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0.0, center - margin), Math.min(1.0, center + margin)];
}

/** Recency weight, half-life ~45 days. A result from today has weight 1.0;
 * one 45 days old has weight 0.5. */
export function decayWeight(daysElapsed, halfLifeDays = 45.0) {
  const d = daysElapsed < 0 ? 0.0 : daysElapsed;
  return 0.5 ** (d / halfLifeDays);
}

/** Tiny deterministic PRNG (mulberry32) so tests can pass a seed and get
 * reproducible bootstrap resamples, matching Python's `random.Random(seed)`
 * determinism guarantee without pulling in a dependency for it. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedChoice(values, weights, rng) {
  if (!weights) return values[Math.floor(rng() * values.length)];
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < values.length; i++) {
    r -= weights[i];
    if (r <= 0) return values[i];
  }
  return values[values.length - 1];
}

/**
 * Bootstrap confidence interval on the mean of `values`, resampling with
 * replacement `resamples` times and taking the requested percentiles of the
 * resampled means. `weights` (same length as `values`), if given, bias the
 * resampling toward higher-weighted (more recent, via `decayWeight`)
 * observations -- this is where recency decay enters the ROI confidence
 * interval; the *point* ROI formula itself stays the unweighted mean.
 */
export function bootstrapCi(values, { weights = null, resamples = 2000, lowPercentile = 5.0, highPercentile = 95.0, seed = null } = {}) {
  if (values.length === 0) throw new Error('cannot bootstrap an empty sample');
  const rng = seed === null ? Math.random : mulberry32(seed);
  const n = values.length;
  const means = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += weightedChoice(values, weights, rng);
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);

  const percentile = (pct) => {
    if (means.length === 1) return means[0];
    const rank = (pct / 100.0) * (means.length - 1);
    const loIdx = Math.floor(rank);
    const hiIdx = Math.min(loIdx + 1, means.length - 1);
    const frac = rank - loIdx;
    return means[loIdx] + (means[hiIdx] - means[loIdx]) * frac;
  };

  return [percentile(lowPercentile), percentile(highPercentile)];
}

export const MIN_SAMPLE_SIZE = 50;
const GRADEABLE_STATUSES = new Set(['won', 'lost']);

export function gradeable(selections) {
  return selections.filter((s) => GRADEABLE_STATUSES.has(s.status));
}

/** (oddsUsed - 1) * payoutFraction for a win, -1 * payoutFraction for a
 * loss -- the exact §7 formula, scaled by payoutFraction for a
 * quarter-line half win/half loss (Task B6); a full win/loss has
 * payoutFraction 1.0 and this is a no-op for every other market. */
export function computeReturns(selections) {
  const returns = [];
  for (const s of selections) {
    const payoutFraction = s.payoutFraction ?? 1.0;
    if (s.status === 'won') {
      if (s.oddsUsed === null || s.oddsUsed === undefined) {
        throw new Error('a won selection must have oddsUsed set');
      }
      returns.push((s.oddsUsed - 1.0) * payoutFraction);
    } else if (s.status === 'lost') {
      returns.push(-1.0 * payoutFraction);
    }
  }
  return returns;
}

export function pointRoi(returns) {
  if (returns.length === 0) return null;
  return returns.reduce((a, b) => a + b, 0) / returns.length;
}

export function hitRate(selections) {
  const g = gradeable(selections);
  if (g.length === 0) return null;
  const wins = g.filter((s) => s.status === 'won').length;
  return wins / g.length;
}

export function avgOdds(selections) {
  const odds = gradeable(selections)
    .map((s) => s.oddsUsed)
    .filter((o) => o !== null && o !== undefined);
  if (odds.length === 0) return null;
  return odds.reduce((a, b) => a + b, 0) / odds.length;
}

export function longestLosingRun(selections) {
  const ordered = [...gradeable(selections)].sort((a, b) => new Date(a.settledAt) - new Date(b.settledAt));
  let longest = 0;
  let current = 0;
  for (const s of ordered) {
    if (s.status === 'lost') {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

/** CLV = (oddsTaken / closingOdds) - 1. closingOdds missing for a
 * selection whose fixture hasn't kicked off yet, or whose closing line was
 * never captured; both are excluded here rather than treated as zero CLV. */
export function clvValues(selections) {
  const values = [];
  for (const s of gradeable(selections)) {
    if (
      s.oddsUsed !== null &&
      s.oddsUsed !== undefined &&
      s.closingOdds !== null &&
      s.closingOdds !== undefined &&
      s.closingOdds > 1.0
    ) {
      values.push(s.oddsUsed / s.closingOdds - 1.0);
    }
  }
  return values;
}

export function meanClv(selections) {
  const values = clvValues(selections);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function pctPositiveClv(selections) {
  const values = clvValues(selections);
  if (values.length === 0) return null;
  return values.filter((v) => v > 0).length / values.length;
}

/** The §7 disqualifiers are all defined in terms of a *post* -- selections
 * with no postId can't trigger any of them. Selections that do carry a
 * postId (social origin, once re-enabled) would need real post metadata
 * this shape doesn't carry yet, so this throws rather than silently doing
 * nothing. */
export function disqualifiersForStrategy(selections) {
  if (selections.some((s) => s.postId !== null && s.postId !== undefined)) {
    throw new Error(
      'social-origin selections found but post-based disqualifier checks are not wired up yet -- ' +
        'the deferred social path (sources.social.enabled) is not re-enabled',
    );
  }
  return [];
}

export function scoreStrategy(selections, { now, halfLifeDays = 45.0, resamples = 2000, seed = null } = {}) {
  const disqualificationReasons = disqualifiersForStrategy(selections);
  const g = gradeable(selections);
  const n = g.length;
  const returns = computeReturns(g);
  const roi = pointRoi(returns);

  let roiCiLow = null;
  let roiCiHigh = null;
  if (returns.length > 0) {
    const weights = g.map((s) => decayWeight((now - new Date(s.settledAt)) / (1000 * 60 * 60 * 24), halfLifeDays));
    [roiCiLow, roiCiHigh] = bootstrapCi(returns, { weights, resamples, seed });
  }

  return {
    nSettled: n,
    roi,
    roiCiLow,
    roiCiHigh,
    hitRate: hitRate(g),
    avgOdds: avgOdds(g),
    meanClv: meanClv(g),
    pctPositiveClv: pctPositiveClv(g),
    longestLosingRun: longestLosingRun(g),
    rated: n >= MIN_SAMPLE_SIZE,
    disqualified: disqualificationReasons.length > 0,
    disqualificationReasons,
  };
}
