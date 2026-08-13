import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { devig, fairOdds, impliedProbability, multiplicativeDevig, powerDevig } from '../lib/devig.js';

// Real Pinnacle 1X2 prices captured in this project's history (Task B1b):
// fixtures/provider_probes/oddspapi_odds_pinnacle.json -- not synthetic.
const REAL_PINNACLE_1X2 = { home: 1.165, draw: 7.66, away: 15.44 };

function approx(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

describe('impliedProbability', () => {
  it('computes 1/odds', () => {
    approx(impliedProbability(2.0), 0.5);
    approx(impliedProbability(1.165), 1 / 1.165);
  });

  it('rejects odds at or below 1.0', () => {
    assert.throws(() => impliedProbability(1.0));
    assert.throws(() => impliedProbability(0.5));
  });
});

describe('fairOdds', () => {
  it('is the inverse of probability', () => {
    approx(fairOdds(0.5), 2.0);
    approx(fairOdds(0.25), 4.0);
  });

  it('rejects out-of-range probability', () => {
    assert.throws(() => fairOdds(0.0));
    assert.throws(() => fairOdds(1.0));
  });
});

describe('multiplicativeDevig', () => {
  it('removes the overround from a symmetric two-way market', () => {
    const fair = multiplicativeDevig({ over: 1.9, under: 1.9 });
    approx(fair.over, 0.5);
    approx(fair.under, 0.5);
    approx(fair.over + fair.under, 1.0);
  });

  it('handles an asymmetric two-way market', () => {
    const fair = multiplicativeDevig({ yes: 1.5, no: 2.8 });
    approx(fair.yes + fair.no, 1.0);
    assert.ok(fair.yes > fair.no);
  });

  it('requires at least two outcomes', () => {
    assert.throws(() => multiplicativeDevig({ only: 1.5 }));
  });
});

describe('powerDevig', () => {
  it('sums to one on real Pinnacle 1X2 data', () => {
    const fair = powerDevig(REAL_PINNACLE_1X2);
    approx(fair.home + fair.draw + fair.away, 1.0, 1e-8);
    assert.ok(fair.home > fair.draw && fair.draw > fair.away);
  });

  it('corrects favorite-longshot bias vs multiplicative de-vigging', () => {
    const powerFair = powerDevig(REAL_PINNACLE_1X2);
    const multFair = multiplicativeDevig(REAL_PINNACLE_1X2);
    assert.ok(powerFair.home > multFair.home);
    assert.ok(powerFair.draw < multFair.draw);
    assert.ok(powerFair.away < multFair.away);
  });

  it('requires exactly three outcomes', () => {
    assert.throws(() => powerDevig({ a: 1.5, b: 2.5 }));
  });

  it('handles a near-certain favorite without diverging', () => {
    const fair = powerDevig({ home: 1.01, draw: 21.0, away: 41.0 });
    approx(fair.home + fair.draw + fair.away, 1.0, 1e-6);
    assert.ok(fair.home > 0 && fair.home < 1);
  });
});

describe('devig', () => {
  it('dispatches two-way markets to multiplicative', () => {
    const fair = devig({ over: 1.9, under: 1.9 });
    const expected = multiplicativeDevig({ over: 1.9, under: 1.9 });
    approx(fair.over, expected.over);
    approx(fair.under, expected.under);
  });

  it('dispatches three-way markets to the power method', () => {
    const fair = devig(REAL_PINNACLE_1X2);
    const expected = powerDevig(REAL_PINNACLE_1X2);
    approx(fair.home, expected.home);
  });

  it('rejects unsupported outcome counts', () => {
    assert.throws(() => devig({ a: 1.5, b: 2.0, c: 3.0, d: 4.0 }));
  });
});
