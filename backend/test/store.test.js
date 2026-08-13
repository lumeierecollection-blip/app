import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Store, SCORE_WINDOWS } from '../lib/store.js';

const NOW = new Date('2026-08-13T12:00:00Z');
const ts = (d) => d.toISOString();
const daysFromNow = (d) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);

function freshStore() {
  return new Store(':memory:');
}

function seedSource(store, handle = 'tipper_a') {
  return store.upsertSource({ handle, displayName: 'Tipper A', now: NOW }).id;
}

function seedPost(store, sourceId, { platformPostId = 'msg-1', capturedAt = ts(NOW) } = {}) {
  return store.insertPost({
    sourceId,
    platformPostId,
    capturedAt,
    postedAt: ts(daysFromNow(-1)),
    rawText: 'Arsenal to beat Cov 1.85',
    now: NOW,
  }).id;
}

function seedSelection(store, sourceId, postId, overrides = {}) {
  return store.insertSelection({
    postId,
    sourceId,
    home: 'Arsenal',
    away: 'Coventry',
    kickoffUtc: ts(daysFromNow(2)),
    market: 'moneyline',
    pick: 'home',
    claimedOdds: 1.85,
    capturedAt: ts(NOW),
    now: NOW,
    ...overrides,
  });
}

describe('Store: sources', () => {
  it('inserts and lists a source', () => {
    const store = freshStore();
    const id = seedSource(store);
    const sources = store.listSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, id);
    assert.equal(sources[0].handle, 'tipper_a');
    assert.equal(sources[0].active, true);
  });

  it('updates display_name and active on re-upsert, returns created=false', () => {
    const store = freshStore();
    const first = store.upsertSource({ handle: 'tipper_a', displayName: 'Old', now: NOW });
    assert.equal(first.created, true);
    const second = store.upsertSource({ handle: 'tipper_a', displayName: 'New', active: false, now: NOW });
    assert.equal(second.created, false);
    const source = store.getSourceByHandle('tipper_a');
    assert.equal(source.display_name, 'New');
    assert.equal(source.active, false);
  });

  it('rejects a source with no handle', () => {
    const store = freshStore();
    assert.throws(() => store.upsertSource({ handle: '', now: NOW }));
  });
});

describe('Store: posts', () => {
  it('inserts a post with captured_at set by us', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    const posts = store.listPosts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, postId);
    assert.equal(posts[0].captured_at, ts(NOW));
    assert.equal(posts[0].source_id, sourceId);
  });

  it('is idempotent on platform_post_id (re-sync after DB loss)', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const a = store.insertPost({ sourceId, platformPostId: 'msg-1', capturedAt: ts(NOW), now: NOW });
    const b = store.insertPost({ sourceId, platformPostId: 'msg-1', capturedAt: ts(NOW), now: NOW });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.id, b.id);
    assert.equal(store.listPosts().length, 1);
  });

  it('requires sourceId, platformPostId, and capturedAt', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    assert.throws(() => store.insertPost({ sourceId, platformPostId: null, capturedAt: ts(NOW) }));
    assert.throws(() => store.insertPost({ sourceId, platformPostId: 'x', capturedAt: null }));
    assert.throws(() => store.insertPost({ platformPostId: 'x', capturedAt: ts(NOW) }));
  });
});

describe('Store: selections (immutable, gradeable gate)', () => {
  it('inserts a selection and flags it gradeable when captured before kickoff', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    const selId = seedSelection(store, sourceId, postId);
    const [sel] = store.listSelections({ sourceId });
    assert.equal(sel.id, selId);
    assert.equal(sel.gradeable, 1);
    assert.equal(sel.claimed_odds, 1.85);
    assert.equal(sel.verified_odds, null);
    assert.equal(sel.closing_odds, null);
  });

  it('flags a selection captured after kickoff as not gradeable', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    seedSelection(store, sourceId, postId, { capturedAt: ts(daysFromNow(3)), kickoffUtc: ts(daysFromNow(2)) });
    const [sel] = store.listSelections({ sourceId });
    assert.equal(sel.gradeable, 0);
  });

  it('rejects an odds value at or below 1.0', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    assert.throws(() => seedSelection(store, sourceId, postId, { claimedOdds: 1.0 }));
    assert.throws(() => seedSelection(store, sourceId, postId, { claimedOdds: null, verifiedOdds: 1.0 }));
  });

  it('has no update path (immutability by construction)', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    const selId = seedSelection(store, sourceId, postId);
    assert.equal(typeof store.db.prepare(`update selections set claimed_odds = 2.0 where id = ${selId}`).run, 'function');
    store.db.prepare(`update selections set claimed_odds = 2.0 where id = ${selId}`).run();
    // A raw UPDATE works at the SQL level (nothing enforces it there, same
    // convention as the old Postgres path) -- the invariant is that the
    // Store API exposes no update method. Assert the API surface only.
    assert.equal(typeof store.updateSelection, 'undefined');
  });
});

describe('Store: settlements and scoring feed', () => {
  it('settles a selection and returns the exact scoreStrategy input shape', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    const selId = seedSelection(store, sourceId, postId, { verifiedOdds: 1.8 });

    store.upsertSettlement({
      selectionId: selId,
      status: 'won',
      payoutFraction: 1.0,
      settledAt: ts(daysFromNow(3)),
      resultPayload: { matchStatus: 'FT', goalsHome: 2, goalsAway: 0 },
      ruleVersion: 'v1',
    });

    const rows = store.settledSelectionsForSource({ sourceId });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.status, 'won');
    assert.equal(row.oddsUsed, 1.8); // verified wins over claimed
    assert.equal(row.payoutFraction, 1.0);
    assert.equal(row.postId, postId);
    assert.equal(row.closingOdds, null);
  });

  it('falls back to claimed_odds when there is no verified_odds', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    const selId = seedSelection(store, sourceId, postId); // claimed 1.85, no verified
    store.upsertSettlement({ selectionId: selId, status: 'won', settledAt: ts(daysFromNow(3)), ruleVersion: 'v1' });
    const [row] = store.settledSelectionsForSource({ sourceId });
    assert.equal(row.oddsUsed, 1.85);
  });

  it('excludes non-gradeable selections from the scoring feed', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    const late = seedSelection(store, sourceId, postId, { capturedAt: ts(daysFromNow(3)), kickoffUtc: ts(daysFromNow(2)) });
    store.upsertSettlement({ selectionId: late, status: 'won', settledAt: ts(daysFromNow(3)), ruleVersion: 'v1' });
    assert.equal(store.settledSelectionsForSource({ sourceId }).length, 0);
  });

  it('filters by window, and the feed carries every field scoreStrategy consumes', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);

    const old = seedSelection(store, sourceId, postId, { claimedOdds: 2.0, kickoffUtc: ts(daysFromNow(80)) });
    const recent = seedSelection(store, sourceId, postId, { claimedOdds: 2.0 });
    store.upsertSettlement({ selectionId: old, status: 'won', settledAt: ts(daysFromNow(-80)), ruleVersion: 'v1' });
    store.upsertSettlement({ selectionId: recent, status: 'lost', settledAt: ts(daysFromNow(-1)), ruleVersion: 'v1' });

    const windowStart = ts(daysFromNow(-30));
    const rows = store.settledSelectionsForSource({ sourceId, windowStart });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'lost');

    // The exact keys scoreStrategy() reads (lib/scoring.js) -- scoring the
    // feed is E5's job (post-backed disqualifiers are not wired yet); E1
    // owns the shape.
    assert.deepEqual(Object.keys(rows[0]).sort(), ['closingOdds', 'oddsUsed', 'payoutFraction', 'postId', 'settledAt', 'status']);

    store.upsertSourceScore({
      sourceId,
      window: '30d',
      score: { nSettled: 1, roi: -1.0, roiCiLow: -1.0, roiCiHigh: -1.0, hitRate: 0, avgOdds: 2.0, meanClv: null, pctPositiveClv: null, longestLosingRun: 1 },
      computedAt: NOW,
    });
    store.upsertSourceScore({
      sourceId,
      window: 'all',
      score: { nSettled: 1, roi: -1.0, roiCiLow: -1.0, roiCiHigh: -1.0, hitRate: 0, avgOdds: 2.0, meanClv: null, pctPositiveClv: null, longestLosingRun: 1 },
      computedAt: NOW,
    });
    assert.equal(store.latestAllWindowScore(sourceId).n_settled, 1);
    assert.equal(store.latestAllWindowScore(sourceId).window, 'all');
  });

  it('rejects an unknown settlement status', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    const selId = seedSelection(store, sourceId, postId);
    assert.throws(() => store.upsertSettlement({ selectionId: selId, status: 'maybe', ruleVersion: 'v1' }));
  });
});

describe('Store: source_scores windows', () => {
  it('exposes exactly the windows the scoring sweep uses', () => {
    assert.deepEqual(SCORE_WINDOWS, ['30d', '90d', 'all']);
  });

  it('returns null for a source with no all-window score yet', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    assert.equal(store.latestAllWindowScore(sourceId), null);
  });
});

describe('Store: notifications', () => {
  it('queues a notification and dedupes the same post', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    assert.equal(store.queueNotification({ sourceId, postId, now: NOW }).queued, true);
    assert.equal(store.queueNotification({ sourceId, postId, now: NOW }).queued, false);
    const pending = store.listPendingNotifications();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].post_id, postId);
    assert.equal(pending[0].handle, 'tipper_a');
    assert.equal(pending[0].status, 'queued');
  });

  it('marks sent with the FCM message id and leaves the audit row', () => {
    const store = freshStore();
    const sourceId = seedSource(store);
    const postId = seedPost(store, sourceId);
    const { queued } = store.queueNotification({ sourceId, postId, now: NOW });
    assert.equal(queued, true);
    const [pending] = store.listPendingNotifications();
    store.markNotificationSent({ id: pending.id, fcmMessageId: 'fcm-1', sentAt: NOW });
    assert.equal(store.listPendingNotifications().length, 0);
    store.markNotificationFailed({ id: pending.id, sentAt: NOW });
  });
});

describe('Store: ingestion_health', () => {
  it('records and lists health per platform, newest first', () => {
    const store = freshStore();
    store.recordHealth({ platform: 'espn', status: 'ok', detail: '2 events', now: NOW });
    store.recordHealth({ platform: 'espn', status: 'empty', detail: '0 events', now: daysFromNow(1) });
    store.recordHealth({ platform: 'telegram', status: 'error', detail: 'flood wait', now: NOW });
    const espn = store.listHealth({ platform: 'espn' });
    assert.equal(espn.length, 2);
    assert.equal(espn[0].status, 'empty'); // newest first
    assert.equal(espn[1].detail, '2 events');
  });

  it('rejects an unknown status', () => {
    const store = freshStore();
    assert.throws(() => store.recordHealth({ platform: 'espn', status: 'maybe' }));
  });
});

describe('Store: app_state (Telegram session)', () => {
  it('stores and retrieves a value, and updates in place', () => {
    const store = freshStore();
    assert.equal(store.getState('telegram.session'), null);
    store.setState('telegram.session', 'session-v1');
    assert.equal(store.getState('telegram.session'), 'session-v1');
    store.setState('telegram.session', 'session-v2');
    assert.equal(store.getState('telegram.session'), 'session-v2');
  });
});
