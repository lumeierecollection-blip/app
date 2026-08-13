/**
 * Tests for OddsPapiProvider against the real captured B1b payload.
 * fixtures/provider_probes/oddspapi_odds_pinnacle.json is not synthetic --
 * it's the actual response OddsPapi returned for real Premier League
 * fixtures during the Task B1b live verification run. Replaying it from a
 * local server proves the parser handles real data, not a shape invented
 * to make its own tests pass. Ported from
 * backend/ingestion/odds/tests/test_oddspapi_provider.py.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const REAL_ODDS_PAYLOAD = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'fixtures', 'provider_probes', 'oddspapi_odds_pinnacle.json'), 'utf8'),
).body;

let server;
let baseUrl;
let OddsPapiProviderClass;
let classifyOutcome;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/v4/odds-by-tournaments') {
      res.end(JSON.stringify(REAL_ODDS_PAYLOAD));
    } else if (url.pathname === '/v4/participants') {
      const ids = (url.searchParams.get('participantIds') || '').split(',').filter(Boolean);
      res.end(JSON.stringify(ids.map((i) => ({ participantId: Number(i), participantName: `Team ${i}` }))));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v4`;

  // Swap the module's BASE_URL for the local replay server. lib/odds.js
  // exports a plain top-level const, not configurable at import time, so
  // this test imports it fresh via a tiny wrapper module instead of
  // monkeypatching (Node has no direct equivalent of pytest's
  // monkeypatch.setattr on a module-level const).
  const mod = await import('../lib/odds.js');
  OddsPapiProviderClass = mod.OddsPapiProvider;
  classifyOutcome = mod.classifyOutcome;
});

after(() => server.close());

// lib/odds.js's BASE_URL is a module-level const pointing at the real
// OddsPapi host, so instead of patching it we build the URL ourselves by
// constructing a provider subclass whose fetchOdds hits our local replay
// server. Simpler: re-require the module's internal fetch logic isn't
// exposed, so this test instead verifies behavior through a lightweight
// fork of the fetch call using the same parsing helpers indirectly, by
// monkeypatching global fetch to redirect oddspapi.io calls to the local
// server -- the same effect as the Python test's BASE_URL patch, adapted
// to what Node's fetch allows.
const realFetch = globalThis.fetch;
function patchFetchToLocalServer() {
  globalThis.fetch = (url, opts) => {
    const redirected = String(url).replace('https://api.oddspapi.io/v4', baseUrl);
    return realFetch(redirected, opts);
  };
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

describe('OddsPapiProvider.fetchOdds against real captured data', () => {
  it('parses all ten real fixtures', async () => {
    patchFetchToLocalServer();
    try {
      const provider = new OddsPapiProviderClass('fake-key');
      const quotes = await provider.fetchOdds({ tournamentId: 17, bookmaker: 'pinnacle' });
      const fixtureIds = new Set(quotes.map((q) => q.providerFixtureId));
      assert.equal(fixtureIds.size, 10);
      assert.ok(fixtureIds.has(1000001772221154));
    } finally {
      restoreFetch();
    }
  });

  it('resolves the moneyline market for the first real fixture with real prices', async () => {
    patchFetchToLocalServer();
    try {
      const provider = new OddsPapiProviderClass('fake-key');
      const quotes = await provider.fetchOdds({ tournamentId: 17, bookmaker: 'pinnacle' });
      const moneyline = quotes.filter((q) => q.providerFixtureId === 1000001772221154 && q.market === 'moneyline');
      const bySelection = Object.fromEntries(moneyline.map((q) => [q.selection, q.odds]));
      assert.equal(bySelection.home, 1.165);
      assert.equal(bySelection.draw, 7.66);
      assert.equal(bySelection.away, 15.44);
    } finally {
      restoreFetch();
    }
  });

  it('resolves only the main totals line, not the ~10 alternates', async () => {
    patchFetchToLocalServer();
    try {
      const provider = new OddsPapiProviderClass('fake-key');
      const quotes = await provider.fetchOdds({ tournamentId: 17, bookmaker: 'pinnacle' });
      const totals = quotes.filter((q) => q.providerFixtureId === 1000001772221154 && q.market === 'totals');
      const linesSeen = new Set(totals.map((q) => q.line));
      assert.deepEqual(linesSeen, new Set([3.0]));
      const bySelection = Object.fromEntries(totals.map((q) => [q.selection, q.odds]));
      assert.equal(bySelection.over, 1.952);
      assert.equal(bySelection.under, 1.884);
    } finally {
      restoreFetch();
    }
  });

  it('excludes period-1 markets sharing outcome ids with period 0', async () => {
    patchFetchToLocalServer();
    try {
      const provider = new OddsPapiProviderClass('fake-key');
      const quotes = await provider.fetchOdds({ tournamentId: 17, bookmaker: 'pinnacle' });
      const moneylineOdds = new Set(
        quotes
          .filter((q) => q.providerFixtureId === 1000001772221154 && q.market === 'moneyline')
          .map((q) => q.odds),
      );
      assert.ok(!moneylineOdds.has(1.534)); // period 1's "home" price -- must not leak in
    } finally {
      restoreFetch();
    }
  });

  it('produces exactly five quotes for the first fixture', async () => {
    patchFetchToLocalServer();
    try {
      const provider = new OddsPapiProviderClass('fake-key');
      const quotes = await provider.fetchOdds({ tournamentId: 17, bookmaker: 'pinnacle' });
      const forFirstFixture = quotes.filter((q) => q.providerFixtureId === 1000001772221154);
      assert.equal(forFirstFixture.length, 5); // 3 moneyline + 2 totals
    } finally {
      restoreFetch();
    }
  });

  it('gives every quote a real team name, not a bare id', async () => {
    patchFetchToLocalServer();
    try {
      const provider = new OddsPapiProviderClass('fake-key');
      const quotes = await provider.fetchOdds({ tournamentId: 17, bookmaker: 'pinnacle' });
      for (const q of quotes) {
        assert.ok(q.home && typeof q.home === 'string');
        assert.ok(q.away && typeof q.away === 'string');
      }
    } finally {
      restoreFetch();
    }
  });
});

describe('classifyOutcome', () => {
  const cases = [
    ['home', ['moneyline', 'home', null]],
    ['draw', ['moneyline', 'draw', null]],
    ['away', ['moneyline', 'away', null]],
    ['2.5/over', ['totals', 'over', 2.5]],
    ['2.5/under', ['totals', 'under', 2.5]],
    ['weird-future-market', ['other', 'weird-future-market', null]],
  ];

  for (const [outcomeId, expected] of cases) {
    it(`classifies "${outcomeId}"`, () => {
      assert.deepEqual(classifyOutcome(outcomeId), expected);
    });
  }
});
