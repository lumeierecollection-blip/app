import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../lib/store.js';
import { disqualificationsForSource, sourceIsNotifiable } from '../lib/disqualifiers.js';

function makeStore() {
  const store = new Store(':memory:');
  const { id } = store.upsertSource({ handle: 'tipmaster' });
  const post = store.insertPost({ sourceId: id, platformPostId: 'p1', capturedAt: '2026-08-01T10:00:00.000Z' });
  return { store, sourceId: id, postId: post.id };
}

/** gradeable selection: captured well before a future kickoff. */
function insertCleanSelection({ store, sourceId, postId, claimed = 1.9, verified = 1.8 }) {
  store.insertSelection({
    postId,
    sourceId,
    competition: 'eng.1',
    home: 'Arsenal',
    away: 'Coventry City',
    kickoffUtc: '2026-08-21T19:00:00.000Z',
    market: 'moneyline',
    pick: 'home',
    claimedOdds: claimed,
    verifiedOdds: verified,
    verifiedOddsSource: 'draftkings',
    capturedAt: '2026-08-01T10:00:00.000Z',
  });
}

test('a clean source has no disqualifications', () => {
  const { store, sourceId, postId } = makeStore();
  for (let i = 0; i < 5; i++) insertCleanSelection({ store, sourceId, postId });
  assert.deepEqual(disqualificationsForSource(store, sourceId), []);
});

test('capture rate above 10% disqualifies; at 10% it does not', () => {
  const { store, sourceId, postId } = makeStore();
  for (let i = 0; i < 9; i++) insertCleanSelection({ store, sourceId, postId });
  store.insertSelection({
    postId,
    sourceId,
    competition: 'eng.1',
    home: 'Arsenal',
    away: 'Coventry City',
    kickoffUtc: '2026-08-21T19:00:00.000Z',
    market: 'moneyline',
    pick: 'home',
    claimedOdds: 1.9,
    capturedAt: '2026-08-21T20:00:00.000Z',
  });
  // 1 of 10 captured at/after kickoff = exactly 10% -> clean.
  assert.deepEqual(disqualificationsForSource(store, sourceId), []);

  store.insertSelection({
    postId,
    sourceId,
    competition: 'eng.1',
    home: 'Arsenal',
    away: 'Coventry City',
    kickoffUtc: '2026-08-21T19:00:00.000Z',
    market: 'moneyline',
    pick: 'home',
    claimedOdds: 1.9,
    capturedAt: '2026-08-21T20:00:00.000Z',
  });
  // 2 of 11 (~18%) -> disqualifies.
  const reasons = disqualificationsForSource(store, sourceId);
  assert.ok(reasons.some((r) => r.includes('post-kickoff capture rate')), reasons.join('; '));
});

test('claimed-odds inflation above 8% disqualifies', () => {
  const { store, sourceId, postId } = makeStore();
  for (let i = 0; i < 4; i++) insertCleanSelection({ store, sourceId, postId, claimed: 2.2, verified: 2.0 });
  const reasons = disqualificationsForSource(store, sourceId);
  assert.ok(reasons.some((r) => r.includes('claimed odds average')), reasons.join('; '));
});

test('a selection posted more than 120 minutes after kickoff disqualifies', () => {
  const { store, sourceId, postId } = makeStore();
  for (let i = 0; i < 10; i++) insertCleanSelection({ store, sourceId, postId });
  const post = store.insertPost({
    sourceId,
    platformPostId: 'late',
    capturedAt: '2026-08-21T22:00:00.000Z',
    postedAt: '2026-08-21T22:00:00.000Z',
    rawText: 'Arsenal to beat Coventry City @ 1.35',
  });
  store.insertSelection({
    postId: post.id,
    sourceId,
    competition: 'eng.1',
    home: 'Arsenal',
    away: 'Coventry City',
    kickoffUtc: '2026-08-21T19:00:00.000Z',
    market: 'moneyline',
    pick: 'home',
    claimedOdds: 1.35,
    capturedAt: '2026-08-21T22:00:00.000Z',
  });
  const reasons = disqualificationsForSource(store, sourceId);
  assert.ok(reasons.some((r) => r.includes('posted > 120 min after kickoff')), reasons.join('; '));
});

test('sourceIsNotifiable: rated + positive roi_ci_low + not disqualified', () => {
  assert.equal(sourceIsNotifiable(null), false);
  assert.equal(
    sourceIsNotifiable({ n_settled: 50, roi_ci_low: 0.02, disqualified: 0 }),
    true,
  );
  assert.equal(
    sourceIsNotifiable({ n_settled: 50, roi_ci_low: 0.02, disqualified: 1 }),
    false,
  );
  assert.equal(sourceIsNotifiable({ n_settled: 50, roi_ci_low: null, disqualified: 0 }), false);
  assert.equal(sourceIsNotifiable({ n_settled: 49, roi_ci_low: 0.02, disqualified: 0 }), false);
  assert.equal(sourceIsNotifiable({ n_settled: 50, roi_ci_low: -0.01, disqualified: 0 }), false);
});
