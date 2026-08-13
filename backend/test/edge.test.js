import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEdge } from '../lib/edge.js';

const REAL_PINNACLE_1X2 = { home: 1.165, draw: 7.66, away: 15.44 };
const NOW = new Date('2026-08-13T12:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60 * 1000);
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

describe('evaluateEdge', () => {
  it('flags a genuinely better soft-book price', () => {
    const result = evaluateEdge({
      sharpOdds: REAL_PINNACLE_1X2,
      selection: 'home',
      offeredOdds: 1.3,
      now: NOW,
      sharpCapturedAt: minutesAgo(1),
      marketFirstSeenAt: hoursAgo(1),
    });
    assert.equal(result.passedGates, true);
    assert.deepEqual(result.rejections, []);
    assert.ok(result.edge > 0.02);
    assert.equal(result.flagged, true);
  });

  it('does not flag a below-threshold edge', () => {
    const result = evaluateEdge({
      sharpOdds: REAL_PINNACLE_1X2,
      selection: 'home',
      offeredOdds: 1.16,
      now: NOW,
      sharpCapturedAt: minutesAgo(1),
      marketFirstSeenAt: hoursAgo(1),
    });
    assert.equal(result.passedGates, true);
    assert.equal(result.flagged, false);
  });

  it('rejects a stale sharp price', () => {
    const result = evaluateEdge({
      sharpOdds: REAL_PINNACLE_1X2,
      selection: 'home',
      offeredOdds: 1.3,
      now: NOW,
      sharpCapturedAt: minutesAgo(30),
      marketFirstSeenAt: hoursAgo(1),
    });
    assert.equal(result.passedGates, false);
    assert.ok(result.rejections.some((r) => r.gate === 'stale_price'));
  });

  it('rejects a line mismatch', () => {
    const result = evaluateEdge({
      sharpOdds: { over: 1.9, under: 1.9 },
      selection: 'over',
      offeredOdds: 2.2,
      now: NOW,
      sharpCapturedAt: minutesAgo(1),
      sharpLine: 2.5,
      softLine: 2.75,
      marketFirstSeenAt: hoursAgo(1),
    });
    assert.equal(result.passedGates, false);
    assert.ok(result.rejections.some((r) => r.gate === 'line_mismatch'));
  });

  it('accepts matching lines', () => {
    const result = evaluateEdge({
      sharpOdds: { over: 1.9, under: 1.9 },
      selection: 'over',
      offeredOdds: 2.2,
      now: NOW,
      sharpCapturedAt: minutesAgo(1),
      sharpLine: 2.5,
      softLine: 2.5,
      marketFirstSeenAt: hoursAgo(1),
    });
    assert.equal(result.passedGates, true);
  });

  it('rejects a suspended market', () => {
    const result = evaluateEdge({
      sharpOdds: REAL_PINNACLE_1X2,
      selection: 'home',
      offeredOdds: 1.3,
      now: NOW,
      sharpCapturedAt: minutesAgo(1),
      sharpSuspended: true,
      marketFirstSeenAt: hoursAgo(1),
    });
    assert.equal(result.passedGates, false);
    assert.ok(result.rejections.some((r) => r.gate === 'suspended_market'));
  });

  it('rejects an outlier edge as a likely data error', () => {
    const result = evaluateEdge({
      sharpOdds: REAL_PINNACLE_1X2,
      selection: 'away',
      offeredOdds: 50.0,
      now: NOW,
      sharpCapturedAt: minutesAgo(1),
      marketFirstSeenAt: hoursAgo(1),
    });
    assert.equal(result.passedGates, false);
    assert.ok(result.rejections.some((r) => r.gate === 'outlier_edge'));
  });

  it('rejects an immature market', () => {
    const result = evaluateEdge({
      sharpOdds: REAL_PINNACLE_1X2,
      selection: 'home',
      offeredOdds: 1.3,
      now: NOW,
      sharpCapturedAt: minutesAgo(1),
      marketFirstSeenAt: minutesAgo(1),
    });
    assert.equal(result.passedGates, false);
    assert.ok(result.rejections.some((r) => r.gate === 'immature_market'));
  });

  it('collects every rejection, not just the first', () => {
    const result = evaluateEdge({
      sharpOdds: REAL_PINNACLE_1X2,
      selection: 'home',
      offeredOdds: 1.3,
      now: NOW,
      sharpCapturedAt: minutesAgo(30),
      sharpSuspended: true,
      marketFirstSeenAt: minutesAgo(1),
    });
    const gates = new Set(result.rejections.map((r) => r.gate));
    assert.deepEqual(gates, new Set(['stale_price', 'suspended_market', 'immature_market']));
  });

  it('raises on an unknown selection', () => {
    assert.throws(() =>
      evaluateEdge({
        sharpOdds: REAL_PINNACLE_1X2,
        selection: 'not_a_real_outcome',
        offeredOdds: 1.3,
        now: NOW,
        sharpCapturedAt: minutesAgo(1),
      }),
    );
  });
});
