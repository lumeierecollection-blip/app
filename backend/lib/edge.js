/**
 * Sanity gates and edge calculation (Task B3, ported from
 * backend/pricing/edge.py in this project's history). Every gate rejection
 * carries a reason -- silently dropping a selection with no logged reason is
 * exactly the kind of failure this project's ingestion-health design refuses
 * to allow elsewhere.
 */

import { devig, fairOdds as fairOddsFromProbability } from './devig.js';

export const DEFAULT_MAX_STALENESS_MS = 5 * 60 * 1000;
export const DEFAULT_MIN_MARKET_AGE_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_SANE_EDGE = 0.25; // 25%; above this, assume a data error, not a real opportunity
export const DEFAULT_EDGE_THRESHOLD = 0.02; // 2%, a setting, not a hardcoded constant

export function checkStaleness(capturedAt, now, maxStalenessMs = DEFAULT_MAX_STALENESS_MS) {
  const ageMs = now.getTime() - capturedAt.getTime();
  if (ageMs > maxStalenessMs) {
    return {
      gate: 'stale_price',
      reason: `sharp price captured ${ageMs}ms ago, exceeds max staleness ${maxStalenessMs}ms`,
    };
  }
  return null;
}

export function checkLineMatch(sharpLine, softLine) {
  if (sharpLine !== softLine) {
    return { gate: 'line_mismatch', reason: `sharp line ${sharpLine} != soft line ${softLine}` };
  }
  return null;
}

export function checkNotSuspended(sharpSuspended, softSuspended) {
  if (sharpSuspended || softSuspended) {
    return { gate: 'suspended_market', reason: 'sharp or soft book market is suspended' };
  }
  return null;
}

export function checkSaneEdge(edge, maxSaneEdge = DEFAULT_MAX_SANE_EDGE) {
  if (edge > maxSaneEdge) {
    return {
      gate: 'outlier_edge',
      reason: `edge ${(edge * 100).toFixed(1)}% exceeds max sane edge ${(maxSaneEdge * 100).toFixed(1)}% -- likely a data error`,
    };
  }
  return null;
}

export function checkMarketMaturity(firstSeenAt, now, minMarketAgeMs = DEFAULT_MIN_MARKET_AGE_MS) {
  const ageMs = now.getTime() - firstSeenAt.getTime();
  if (ageMs < minMarketAgeMs) {
    return { gate: 'immature_market', reason: `market only ${ageMs}ms old, under minimum ${minMarketAgeMs}ms` };
  }
  return null;
}

/**
 * De-vig the sharp book's prices, compute the edge of `offeredOdds` on
 * `selection`, and run every sanity gate -- collecting every rejection
 * rather than stopping at the first, so the logged reason is always
 * complete.
 */
export function evaluateEdge({
  sharpOdds,
  selection,
  offeredOdds,
  now,
  sharpCapturedAt,
  sharpLine = null,
  softLine = null,
  sharpSuspended = false,
  softSuspended = false,
  marketFirstSeenAt = null,
  edgeThreshold = DEFAULT_EDGE_THRESHOLD,
  maxStalenessMs = DEFAULT_MAX_STALENESS_MS,
  maxSaneEdge = DEFAULT_MAX_SANE_EDGE,
  minMarketAgeMs = DEFAULT_MIN_MARKET_AGE_MS,
}) {
  const fairProbs = devig(sharpOdds);
  if (!(selection in fairProbs)) {
    throw new Error(`selection ${selection} not found in sharpOdds outcomes ${Object.keys(sharpOdds)}`);
  }
  const probability = fairProbs[selection];
  const odds = fairOddsFromProbability(probability);
  const edge = offeredOdds * probability - 1.0;

  const rejections = [];
  for (const check of [
    checkStaleness(sharpCapturedAt, now, maxStalenessMs),
    checkLineMatch(sharpLine, softLine),
    checkNotSuspended(sharpSuspended, softSuspended),
    checkSaneEdge(edge, maxSaneEdge),
  ]) {
    if (check !== null) rejections.push(check);
  }
  if (marketFirstSeenAt !== null) {
    const maturity = checkMarketMaturity(marketFirstSeenAt, now, minMarketAgeMs);
    if (maturity !== null) rejections.push(maturity);
  }

  const passedGates = rejections.length === 0;
  const flagged = passedGates && edge > edgeThreshold;

  return {
    fairProbability: probability,
    fairOdds: odds,
    edge,
    passedGates,
    rejections,
    flagged,
  };
}
