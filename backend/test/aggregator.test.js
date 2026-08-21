import test from 'node:test';
import assert from 'node:assert/strict';

import { createAggregator, marketLineOdds, SETTLE_GRACE_MS } from '../lib/aggregator.js';

/** Fake ESPN adapter: a league/day -> events map standing in for the real
 * scoreboard endpoint. */
function fakeEspn(pages) {
  return {
    fetchScoreboard: async ({ league, date = null }) => {
      const key = date ? `${league}|${date.toISOString().slice(0, 10)}` : league;
      if (!(key in pages)) throw new Error(`no page for ${key}`);
      return { events: pages[key] ?? [], skipped: 0 };
    },
  };
}

function event(id, { league = 'eng.1', date, state = 'pre', homeScore = null, awayScore = null, odds = null } = {}) {
  const completed = state === 'post';
  return {
    id,
    league,
    date,
    status: {
      state,
      name: completed ? 'STATUS_FULL_TIME' : 'STATUS_SCHEDULED',
      completed,
      normalized: completed ? 'FT' : null,
    },
    home: { name: 'Arsenal', abbreviation: 'ARS', score: homeScore },
    away: { name: 'Chelsea', abbreviation: 'CHE', score: awayScore },
    odds,
  };
}

const TIP_TEXT = 'Arsenal to beat Chelsea @ 2.10';

function channelPost(id, text, postedAt) {
  return { id, channel: 'tipsterdemo', text, postedAt, url: `https://t.me/${id}` };
}

test('marketLineOdds reads the close price per market (ported helper)', () => {
  const e = event('1', {
    odds: {
      moneyline: { home: { open: 1.8, close: 1.85 }, draw: {}, away: {} },
      totals: { over: { close: 1.9 }, under: { close: 1.95 } },
      spread: null,
    },
  });
  assert.equal(marketLineOdds(e, 'moneyline', 'home'), 1.85);
  assert.equal(marketLineOdds(e, 'totals', 'over'), 1.9);
  assert.equal(marketLineOdds(e, 'asian_handicap', 'home'), null);
  assert.equal(marketLineOdds(null, 'moneyline', 'home'), null);
});

test('scan ingests posts into the feed with verified odds at insert time', async () => {
  const kickoff = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const agg = createAggregator({
    leagues: ['eng.1'],
    channels: ['tipsterdemo'],
    espn: fakeEspn({
      'eng.1': [event('9001', { date: kickoff, odds: { moneyline: { home: { open: 2.0, close: 2.05 }, draw: {}, away: {} } } })],
    }),
    fetchChannelPosts: async () => [channelPost('tg-tipsterdemo/1', TIP_TEXT, new Date().toISOString())],
    now: () => new Date(),
  });

  const summary = await agg.scan();
  assert.equal(summary.espnEvents, 1);
  assert.equal(summary.newPosts, 1);
  assert.equal(summary.selectionsInserted, 1);

  const feed = agg.postsPayload({ limit: 10 });
  const post = feed.find((p) => p.handle === 'tipsterdemo');
  assert.ok(post, 'real post present');
  assert.equal(post.source_display_name, '@tipsterdemo');
  assert.equal(post.selection_count, 1);
  assert.ok(feed.some((p) => p.handle === 'fixture-pulse'), 'fixture pulse entries render too');

  const sel = agg.state.selections[0];
  assert.equal(sel.verifiedOdds, 2.05, 'verified price captured from the close line at insert');
  assert.equal(sel.providerEventId, '9001');

  // Idempotent ingest: the same post id is never counted twice.
  const second = await agg.scan();
  assert.equal(second.newPosts, 0);
});

test('settles a won pick against the real result and scores the channel', async () => {
  // Kickoff far enough in the past to be inside the settle window.
  const kickoff = new Date(Date.now() - SETTLE_GRACE_MS - 3600 * 1000).toISOString();
  const day = kickoff.slice(0, 10);
  const finished = event('9001', {
    date: kickoff,
    state: 'post',
    homeScore: 3,
    awayScore: 1,
    odds: { moneyline: { home: { open: 2.0, close: 2.0 }, draw: {}, away: {} } },
  });
  const agg = createAggregator({
    leagues: ['eng.1'],
    channels: ['tipsterdemo'],
    espn: fakeEspn({
      'eng.1': [],
      [`eng.1|${day}`]: [finished],
    }),
    fetchChannelPosts: async () => [
      channelPost('tg-tipsterdemo/1', `Arsenal to beat Chelsea @ 2.10 (kickoff ${kickoff})`, kickoff),
    ],
    extract: (text) => ({
      picks: [
        {
          providerEventId: '9001',
          competition: 'eng.1',
          home: 'Arsenal',
          away: 'Chelsea',
          kickoffUtc: kickoff,
          market: 'moneyline',
          pick: 'home',
          line: null,
          claimedOdds: 2.1,
        },
      ],
      unparsed: [],
    }),
    now: () => new Date(),
  });

  await agg.scan();
  const sel = agg.state.selections[0];
  assert.ok(sel.settlement, 'settled on the first scan');
  assert.equal(sel.settlement.status, 'won');
  assert.equal(sel.settlement.closingOdds, 2.0);

  const { sources } = agg.sourcesPayload();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].handle, 'tipsterdemo');
  assert.equal(sources[0].score.nSettled, 1);
  assert.equal(sources[0].score.rated, false, 'one bet is far below the 50-sample gate');
  assert.ok(Math.abs(sources[0].score.roi - 1.1) < 1e-9, 'ROI of a 2.10 win is +110%');
  assert.ok(Math.abs(sources[0].score.meanClv - (2.1 / 2.0 - 1)) < 1e-9, 'CLV vs the closing line');
});

test('an ESPN outage records an error and never looks like empty data', async () => {
  const agg = createAggregator({
    leagues: ['eng.1'],
    channels: [],
    espn: fakeEspn({}),
    fetchChannelPosts: async () => [],
    now: () => new Date(),
  });
  const summary = await agg.scan();
  assert.equal(summary.espnStatus['eng.1'], 'error');
  assert.ok(summary.errors.length > 0);
  assert.equal(agg.state.lastScanError !== null, true);
});

test('an unconfigured server scans cleanly and reports not-configured', async () => {
  const agg = createAggregator({ leagues: [], channels: [], now: () => new Date() });
  const summary = await agg.scan();
  assert.deepEqual(summary.errors, []);
  const status = agg.statusSnapshot();
  assert.equal(status.telegram.configured, false);
  assert.equal(status.telegram.state, 'not configured');
  assert.deepEqual(agg.sourcesPayload().sources, []);
});
