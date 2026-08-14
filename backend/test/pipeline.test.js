import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../lib/store.js';
import { ScanRunner } from '../lib/pipeline.js';
import { dateKey } from '../lib/espn.js';

const KICKOFF = '2026-08-21T19:00:00.000Z';

function makeEvent(overrides = {}) {
  return {
    id: '401879301',
    league: 'eng.1',
    date: KICKOFF,
    status: { state: 'pre', name: 'STATUS_SCHEDULED', completed: false, normalized: null },
    home: { name: 'Arsenal', abbreviation: 'ARS', score: null },
    away: { name: 'Coventry City', abbreviation: 'COV', score: null },
    details: [],
    odds: {
      provider: 'DraftKings',
      moneyline: { home: { open: 1.35, close: 1.4 }, draw: { open: 5.5, close: 5.5 }, away: { open: 7.5, close: 7.5 } },
      totals: { line: 2.5, over: { open: 1.7, close: 1.7 }, under: { open: 2.1, close: 2.1 } },
      spread: null,
    },
    ...overrides,
  };
}

function makeEspn({ upcoming = [], resultsByDay = {} } = {}) {
  return {
    fetchScoreboard: async ({ league, date }) => {
      const key = date ? dateKey(date) : 'today';
      const events = key === 'today' ? upcoming : (resultsByDay[key] ?? []);
      return { events, skipped: 0 };
    },
  };
}

function makePoller(messagesByMinId, session = 'session-xyz') {
  return {
    get sessionString() {
      return session;
    },
    fetchRecentMessages: async (_handle, { minId }) => messagesByMinId[minId] ?? [],
  };
}

const MSG_100 = {
  platformPostId: '100',
  postedAt: '2026-08-10T09:00:00.000Z',
  text: 'Arsenal to beat Coventry City @ 1.35',
  media: false,
  edited: false,
};
const MSG_101 = {
  platformPostId: '101',
  postedAt: '2026-08-21T18:30:00.000Z',
  text: 'Arsenal to beat Coventry City @ 1.40',
  media: false,
  edited: false,
};

test('pipeline end-to-end: ingest -> verified odds -> settle -> score -> notify', async () => {
  const store = new Store(':memory:');
  const sent = [];
  const upcoming = [makeEvent()];
  const resultsByDay = {
    '20260821': [
      makeEvent({
        status: { state: 'post', name: 'STATUS_FULL_TIME', completed: true, normalized: 'FT' },
        home: { name: 'Arsenal', abbreviation: 'ARS', score: 2 },
        away: { name: 'Coventry City', abbreviation: 'COV', score: 1 },
      }),
    ],
  };
  const espn = makeEspn({ upcoming, resultsByDay });
  const poller = makePoller({ 0: [MSG_100], 100: [MSG_101] });
  const notify = async (payload) => {
    sent.push(payload);
  };

  const run1Now = new Date('2026-08-10T10:00:00.000Z');
  const runner = new ScanRunner({ store, poller, espn, notify, now: () => run1Now });

  // --- run 1: ingest only ------------------------------------------------
  const s1 = await runner.run({ channels: ['tipmaster'], leagues: ['eng.1'] });
  assert.equal(s1.postsIngested, 1);
  assert.equal(s1.newPosts, 1);
  assert.equal(s1.selectionsInserted, 1);
  assert.equal(s1.selectionsSettled, 0);
  assert.equal(store.getState('telegram.lastMsg.tipmaster'), '100');
  assert.equal(store.getState('telegram.session'), 'session-xyz');

  const source = store.getSourceByHandle('tipmaster');
  const posts = store.listPosts();
  assert.equal(posts.length, 1);
  const run1Selection = store.listSelections({ sourceId: source.id })[0];
  assert.equal(run1Selection.verified_odds, 1.4, 'verified odds filled at insert from the fixture close line');
  assert.equal(run1Selection.verified_odds_source, 'draftkings');
  assert.equal(run1Selection.gradeable, 1, 'captured well before kickoff -> gradeable');

  // The real-life wait for 50 settled bets, compressed: backfill 49 more
  // gradeable selections on the same fixture so the gate actually fires.
  for (let i = 0; i < 49; i++) {
    store.insertSelection({
      postId: posts[0].id,
      sourceId: source.id,
      providerEventId: '401879301',
      competition: 'eng.1',
      home: 'Arsenal',
      away: 'Coventry City',
      kickoffUtc: KICKOFF,
      market: 'moneyline',
      pick: 'home',
      claimedOdds: 1.35,
      verifiedOdds: 1.4,
      verifiedOddsSource: 'draftkings',
      capturedAt: '2026-08-01T10:00:00.000Z',
      now: run1Now,
    });
  }

  // --- run 2: new post + settlement + scoring + notification --------------
  const run2Now = new Date('2026-08-21T22:30:00.000Z');
  runner.now = () => run2Now;
  store.registerDevice({ token: 'tok-1' });

  const s2 = await runner.run({ channels: ['tipmaster'], leagues: ['eng.1'] });
  assert.equal(s2.newPosts, 1);
  assert.equal(s2.selectionsSettled, 51, '50 gradeable + 1 post-kickoff selection all settle');
  assert.equal(s2.sourcesScored, 1);
  assert.equal(s2.notificationsQueued, 1);
  assert.equal(s2.notificationsSent, 1);
  assert.equal(store.getState('telegram.lastMsg.tipmaster'), '101');

  const score = store.latestAllWindowScore(source.id);
  assert.equal(score.n_settled, 50, 'post-kickoff selection excluded from the scoring feed');
  assert.ok(Math.abs(score.roi - 0.4) < 1e-9, `roi should be 0.40, got ${score.roi}`);
  assert.ok(score.roi_ci_low > 0);
  assert.equal(score.disqualified, 0);
  assert.equal(score.mean_clv, 0, 'closing line equals the verified line here');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 'tok-1');
  assert.equal(sent[0].title, 'tipmaster');
  assert.match(sent[0].body, /1\.40/);
  assert.equal(sent[0].data.sourceHandle, 'tipmaster');

  const notifications = store.listPendingNotifications({ limit: 10 });
  assert.equal(notifications.length, 0, 'notification drained (sent)');

  const health = store.listHealth({ platform: 'espn', limit: 10 });
  assert.ok(health.length > 0);
  const telegramHealth = store.listHealth({ platform: 'telegram', limit: 10 });
  assert.ok(telegramHealth.some((h) => h.status === 'ok'));
});

test('pipeline keeps working when a channel fails mid-poll (health records the error)', async () => {
  const store = new Store(':memory:');
  const espn = makeEspn({ upcoming: [makeEvent()] });
  const poller = {
    get sessionString() {
      return 'session-xyz';
    },
    fetchRecentMessages: async () => {
      throw new Error('AUTH_KEY_UNREGISTERED');
    },
  };
  const runner = new ScanRunner({ store, poller, espn, now: () => new Date('2026-08-10T10:00:00.000Z') });

  const summary = await runner.run({ channels: ['brokenchannel'], leagues: ['eng.1'] });
  assert.equal(summary.newPosts, 0);
  assert.equal(summary.sourcesScored, 1, 'a failed channel must not abort the whole scan');
  const telegramHealth = store.listHealth({ platform: 'telegram', limit: 5 });
  assert.equal(telegramHealth[0].status, 'error');
  assert.match(telegramHealth[0].detail, /AUTH_KEY_UNREGISTERED/);
});

test('marketLineOdds returns the right close line per market', async () => {
  const { marketLineOdds } = await import('../lib/pipeline.js');
  const event = makeEvent();
  assert.equal(marketLineOdds(event, 'moneyline', 'home'), 1.4);
  assert.equal(marketLineOdds(event, 'moneyline', 'away'), 7.5);
  assert.equal(marketLineOdds(event, 'totals', 'over'), 1.7);
  assert.equal(marketLineOdds(event, 'btts', 'yes'), null);
  assert.equal(marketLineOdds({ ...event, odds: null }, 'moneyline', 'home'), null);
});
