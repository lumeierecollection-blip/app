import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SAMPLE_SIZE,
  avgOdds,
  bootstrapCi,
  clvValues,
  computeReturns,
  decayWeight,
  disqualifiersForStrategy,
  gradeable,
  hitRate,
  longestLosingRun,
  meanClv,
  pctPositiveClv,
  pointRoi,
  scoreStrategy,
  wilsonInterval,
} from '../lib/scoring.js';

function approx(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

const NOW = new Date('2026-08-13T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

function make(status, oddsUsed = null, daysAgoN = 1, closingOdds = null, postId = null, payoutFraction = 1.0) {
  return { status, oddsUsed, settledAt: daysAgo(daysAgoN), closingOdds, postId, payoutFraction };
}

describe('wilsonInterval', () => {
  it('is wide for a small sample', () => {
    const [lo, hi] = wilsonInterval(1, 2);
    assert.ok(lo >= 0 && lo < 0.5 && 0.5 < hi && hi <= 1.0);
    assert.ok(hi - lo > 0.4);
  });

  it('narrows with more data at the same rate', () => {
    const [loSmall, hiSmall] = wilsonInterval(5, 10);
    const [loBig, hiBig] = wilsonInterval(500, 1000);
    assert.ok(hiBig - loBig < hiSmall - loSmall);
  });

  it('has an upper bound of exactly 1.0 for a perfect record (correct math, not overconfidence)', () => {
    const [lo, hi] = wilsonInterval(10, 10);
    approx(hi, 1.0);
    assert.ok(lo < 0.8);
  });

  it('rejects invalid input', () => {
    assert.throws(() => wilsonInterval(0, 0));
    assert.throws(() => wilsonInterval(11, 10));
  });
});

describe('decayWeight', () => {
  it('is 1.0 at zero days elapsed', () => approx(decayWeight(0, 45.0), 1.0));
  it('is 0.5 at one half-life', () => approx(decayWeight(45.0, 45.0), 0.5));
  it('is 0.25 at two half-lives', () => approx(decayWeight(90.0, 45.0), 0.25));
  it('clamps negative elapsed time to full weight', () => approx(decayWeight(-5.0, 45.0), 1.0));
});

describe('bootstrapCi', () => {
  it('brackets the true mean for a known distribution', () => {
    const values = [...Array(60).fill(1.0), ...Array(40).fill(-1.0)]; // mean = 0.2
    const [lo, hi] = bootstrapCi(values, { resamples: 2000, seed: 42 });
    assert.ok(lo < 0.2 && 0.2 < hi);
  });

  it('is narrower for larger samples', () => {
    const small = [...Array(6).fill(1.0), ...Array(4).fill(-1.0)];
    const large = [...Array(600).fill(1.0), ...Array(400).fill(-1.0)];
    const [loS, hiS] = bootstrapCi(small, { resamples: 2000, seed: 1 });
    const [loL, hiL] = bootstrapCi(large, { resamples: 2000, seed: 1 });
    assert.ok(hiL - loL < hiS - loS);
  });

  it('is deterministic with a seed', () => {
    const values = [1.0, -1.0, 0.5, -1.0, 2.0];
    const first = bootstrapCi(values, { resamples: 500, seed: 7 });
    const second = bootstrapCi(values, { resamples: 500, seed: 7 });
    assert.deepEqual(first, second);
  });

  it('biases toward higher-weighted values', () => {
    const values = [...Array(10).fill(1.0), -1.0];
    const weights = [...Array(10).fill(1.0), 1000.0];
    const [, hi] = bootstrapCi(values, { weights, resamples: 2000, seed: 3 });
    assert.ok(hi < 0.5);
  });

  it('rejects an empty sample', () => {
    assert.throws(() => bootstrapCi([]));
  });
});

describe('gradeable / returns / hitRate / avgOdds', () => {
  it('excludes void, push, and ungradeable', () => {
    const selections = [make('won', 2.0), make('lost'), make('void'), make('push'), make('ungradeable')];
    assert.equal(gradeable(selections).length, 2);
  });

  it('computeReturns matches the docs/SCORING.md formula', () => {
    const selections = [make('won', 2.5), make('won', 1.5), make('lost')];
    const returns = computeReturns(selections);
    assert.deepEqual(returns.map((r) => Math.round(r * 1000) / 1000), [1.5, 0.5, -1.0]);
  });

  it('pointRoi is the mean of returns', () => {
    approx(pointRoi([1.0, -1.0, -1.0, 2.0]), 0.25);
  });

  it('pointRoi is null for no gradeable bets', () => {
    assert.equal(pointRoi([]), null);
  });

  it('hitRate only counts gradeable selections', () => {
    const selections = [make('won', 2.0), make('won', 2.0), make('lost'), make('void')];
    approx(hitRate(selections), 2 / 3);
  });

  it('avgOdds is over gradeable only', () => {
    const selections = [make('won', 2.0), make('lost', 3.0), make('void')];
    approx(avgOdds(selections), 2.5);
  });
});

describe('longestLosingRun', () => {
  it('counts consecutive losses in time order', () => {
    const selections = [
      make('won', 2.0, 5),
      make('lost', null, 4),
      make('lost', null, 3),
      make('lost', null, 2),
      make('won', 2.0, 1),
    ];
    assert.equal(longestLosingRun(selections), 3);
  });

  it('is zero with no losses', () => {
    assert.equal(longestLosingRun([make('won', 2.0)]), 0);
  });
});

describe('CLV', () => {
  it('clvValues skips selections without a closing line', () => {
    const selections = [
      make('won', 2.0, 1, 1.8), // CLV = 2.0/1.8 - 1
      make('lost', null, 1, null),
      make('won', 1.5, 1, 1.6), // negative CLV
    ];
    const values = clvValues(selections);
    assert.equal(values.length, 2);
    approx(values[0], 2.0 / 1.8 - 1);
  });

  it('computes mean and pct positive CLV', () => {
    const selections = [make('won', 2.0, 1, 1.8), make('lost', 1.5, 1, 1.6)];
    assert.notEqual(meanClv(selections), null);
    approx(pctPositiveClv(selections), 0.5);
  });

  it('meanClv is null with no closing lines', () => {
    assert.equal(meanClv([make('won', 2.0)]), null);
  });
});

describe('disqualifiersForStrategy', () => {
  it('is a no-op for pure odds-market selections', () => {
    assert.deepEqual(disqualifiersForStrategy([make('won', 2.0), make('lost')]), []);
  });

  it('throws for unhandled social-origin selections', () => {
    assert.throws(() => disqualifiersForStrategy([make('won', 2.0, 1, null, 'some-post-id')]));
  });
});

describe('scoreStrategy', () => {
  it('is unrated under 50 samples', () => {
    const selections = Array.from({ length: 10 }, (_, i) => make('won', 2.0, i));
    const result = scoreStrategy(selections, { now: NOW });
    assert.equal(result.nSettled, 10);
    assert.equal(result.rated, false);
  });

  it('is rated at 50 samples', () => {
    const selections = Array.from({ length: MIN_SAMPLE_SIZE }, (_, i) => make('won', 2.0, i));
    const result = scoreStrategy(selections, { now: NOW });
    assert.equal(result.nSettled, MIN_SAMPLE_SIZE);
    assert.equal(result.rated, true);
    approx(result.roi, 1.0); // every bet won at odds 2.0 -> return of 1.0 each
    assert.notEqual(result.roiCiLow, null);
    assert.notEqual(result.roiCiHigh, null);
  });

  it('excludes void and push from the sample gate', () => {
    const selections = [
      ...Array.from({ length: MIN_SAMPLE_SIZE }, (_, i) => make('won', 2.0, i)),
      ...Array.from({ length: 10 }, (_, i) => make('void', null, i)),
      ...Array.from({ length: 10 }, (_, i) => make('push', null, i)),
    ];
    const result = scoreStrategy(selections, { now: NOW });
    assert.equal(result.nSettled, MIN_SAMPLE_SIZE);
  });
});
