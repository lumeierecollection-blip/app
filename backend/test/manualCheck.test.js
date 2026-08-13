import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NoSharpPriceError, evaluateManualCheck, kellyStakeFraction } from '../lib/manualCheck.js';

function approx(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

const NOW = new Date('2026-08-13T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000);

const REAL_PINNACLE_QUOTES = [
  { selection: 'home', odds: 1.165, line: null, capturedAt: minutesAgo(1) },
  { selection: 'draw', odds: 7.66, line: null, capturedAt: minutesAgo(1) },
  { selection: 'away', odds: 15.44, line: null, capturedAt: minutesAgo(1) },
];

describe('kellyStakeFraction', () => {
  it('is null with no edge', () => {
    assert.equal(kellyStakeFraction(0.0, 2.0), null);
    assert.equal(kellyStakeFraction(-0.05, 2.0), null);
  });

  it('is quarter-Kelly, capped, for a positive edge', () => {
    // edge=0.10, offered=2.0 -> net_odds=1.0, full kelly = 0.10, quarter = 0.025
    approx(kellyStakeFraction(0.1, 2.0), 0.025);
  });

  it('respects the hard cap', () => {
    approx(kellyStakeFraction(0.9, 1.5, 1.0), 0.05);
  });
});

describe('evaluateManualCheck', () => {
  it('finds a real edge', () => {
    const result = evaluateManualCheck({
      quotes: REAL_PINNACLE_QUOTES,
      fixtureId: 'f1',
      market: 'moneyline',
      pick: 'home',
      enteredOdds: 1.3,
      enteredBookmaker: 'local-book',
      now: NOW,
    });
    assert.equal(result.passedGates, true);
    assert.ok(result.edge > 0.02);
    assert.notEqual(result.stakeFraction, null);
    assert.ok(result.stakeFraction > 0);
  });

  it('throws NoSharpPriceError with no quotes at all', () => {
    assert.throws(
      () =>
        evaluateManualCheck({
          quotes: [],
          fixtureId: 'f1',
          market: 'moneyline',
          pick: 'home',
          enteredOdds: 1.3,
          enteredBookmaker: 'local-book',
          now: NOW,
        }),
      NoSharpPriceError,
    );
  });

  it('throws for an unknown pick', () => {
    assert.throws(() =>
      evaluateManualCheck({
        quotes: REAL_PINNACLE_QUOTES,
        fixtureId: 'f1',
        market: 'moneyline',
        pick: 'not_a_real_selection',
        enteredOdds: 1.3,
        enteredBookmaker: 'local-book',
        now: NOW,
      }),
    );
  });

  it('never recommends a stake on a rejected check', () => {
    const staleQuotes = REAL_PINNACLE_QUOTES.map((q) => ({ ...q, capturedAt: minutesAgo(30) }));
    const result = evaluateManualCheck({
      quotes: staleQuotes,
      fixtureId: 'f1',
      market: 'moneyline',
      pick: 'home',
      enteredOdds: 1.3,
      enteredBookmaker: 'local-book',
      now: NOW,
    });
    assert.equal(result.passedGates, false);
    assert.equal(result.stakeFraction, null);
  });
});
