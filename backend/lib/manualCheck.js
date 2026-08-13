/**
 * Task B4 -- manual price check, ported from backend/manual_check/service.py
 * in this project's history: the primary way this system gets used against
 * a bookmaker not covered by the odds API. Pick a fixture/market, see the
 * fair price computed from the sharp (Pinnacle) line, type in what your own
 * bookmaker actually offers, get back the edge and a stake-fraction
 * recommendation.
 */

import { DEFAULT_EDGE_THRESHOLD, evaluateEdge } from './edge.js';

export const SHARP_BOOKMAKER = 'pinnacle';

// Quarter-Kelly, not full Kelly: full Kelly stakes assume the edge estimate
// is exact, but a de-vigged market price is a best estimate, not a
// certainty, and full Kelly is punishing when that estimate is wrong.
export const DEFAULT_KELLY_FRACTION = 0.25;
export const MAX_STAKE_FRACTION = 0.05; // hard cap regardless of what Kelly suggests

export class NoSharpPriceError extends Error {}

/** Fractional-Kelly stake as a share of bankroll. null (not zero) when
 * there's no positive edge -- "no bet" is a different fact from "bet 0%". */
export function kellyStakeFraction(edge, offeredOdds, kellyFraction = DEFAULT_KELLY_FRACTION) {
  if (edge <= 0) return null;
  const netOdds = offeredOdds - 1.0;
  const fullKelly = edge / netOdds;
  return Math.min(fullKelly * kellyFraction, MAX_STAKE_FRACTION);
}

/**
 * Compute the fair price from the real sharp-book line, then the edge and
 * stake recommendation for what the user actually typed in. `quotes` is the
 * latest sharp-book snapshot per selection for this fixture/market (from
 * lib/supabase.js's fetchLatestSharpQuotes) -- fetched separately so the
 * caller can show the fair price live before an offered price is typed in.
 */
export function evaluateManualCheck({
  quotes,
  fixtureId,
  market,
  pick,
  enteredOdds,
  enteredBookmaker,
  now,
  line = null,
  edgeThreshold = DEFAULT_EDGE_THRESHOLD,
  kellyFraction = DEFAULT_KELLY_FRACTION,
}) {
  if (quotes.length === 0) {
    throw new NoSharpPriceError(`no sharp-book quotes for fixture ${fixtureId} market ${market}`);
  }

  const sharpOdds = {};
  const bySelection = {};
  for (const q of quotes) {
    sharpOdds[q.selection] = q.odds;
    bySelection[q.selection] = q;
  }
  if (!(pick in sharpOdds)) {
    throw new Error(`pick ${pick} not among sharp-book selections ${Object.keys(sharpOdds)}`);
  }

  const sharpCapturedAt = bySelection[pick].capturedAt;
  const sharpLine = bySelection[pick].line ?? null;

  const evaluation = evaluateEdge({
    sharpOdds,
    selection: pick,
    offeredOdds: enteredOdds,
    now,
    sharpCapturedAt,
    sharpLine,
    softLine: line,
    edgeThreshold,
  });

  const stakeFraction = evaluation.passedGates
    ? kellyStakeFraction(evaluation.edge, enteredOdds, kellyFraction)
    : null;

  return {
    fixtureId,
    market,
    pick,
    line,
    fairProbability: evaluation.fairProbability,
    fairOdds: evaluation.fairOdds,
    enteredOdds,
    enteredBookmaker,
    edge: evaluation.edge,
    stakeFraction,
    passedGates: evaluation.passedGates,
    rejections: evaluation.rejections,
    checkedAt: now,
  };
}
