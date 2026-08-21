import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  americanToDecimal,
  dateKey,
  normalizeMatchStatus,
  parseScoreboard,
  resultPayload,
  settledMatches,
  upcomingFixtures,
} from '../lib/espn.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'espn');
const eng1Raw = JSON.parse(readFileSync(join(FIXTURES, 'eng1_scoreboard.json'), 'utf8'));
const usa1Raw = JSON.parse(readFileSync(join(FIXTURES, 'usa1_scoreboard_20260808.json'), 'utf8'));

function approx(actual, expected, tolerance = 1e-4) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

describe('americanToDecimal', () => {
  it('converts negative (favourite) odds', () => {
    approx(americanToDecimal('-190'), 1.5263);
    approx(americanToDecimal('-600'), 1.1667);
  });

  it('converts positive odds, with and without the leading +', () => {
    approx(americanToDecimal('+140'), 2.4);
    approx(americanToDecimal('140'), 2.4); // ESPN drops the + for positives
    approx(americanToDecimal('+650'), 7.5);
  });

  it('returns null for pick-ems, junk, and missing values', () => {
    assert.equal(americanToDecimal(0), null);
    assert.equal(americanToDecimal('0'), null);
    assert.equal(americanToDecimal('abc'), null);
    assert.equal(americanToDecimal(null), null);
    assert.equal(americanToDecimal(undefined), null);
  });
});

describe('normalizeMatchStatus', () => {
  it('maps finished and void states onto the settlement contract', () => {
    assert.equal(normalizeMatchStatus('STATUS_FULL_TIME'), 'FT');
    assert.equal(normalizeMatchStatus('STATUS_FT_AET'), 'AET');
    assert.equal(normalizeMatchStatus('STATUS_FINAL_PEN'), 'PEN');
    assert.equal(normalizeMatchStatus('STATUS_POSTPONED'), 'POSTP');
    assert.equal(normalizeMatchStatus('STATUS_CANCELED'), 'CANC');
    assert.equal(normalizeMatchStatus('STATUS_AWARDED'), 'AWD');
  });

  it('returns null for anything not yet settleable', () => {
    assert.equal(normalizeMatchStatus('STATUS_SCHEDULED'), null);
    assert.equal(normalizeMatchStatus('STATUS_IN_PROGRESS'), null);
    assert.equal(normalizeMatchStatus('STATUS_HALFTIME'), null);
    assert.equal(normalizeMatchStatus('STATUS_SUSPENDED'), null);
    assert.equal(normalizeMatchStatus('SOMETHING_NEW_ESPN_INVENTED'), null);
  });
});

describe('dateKey', () => {
  it('formats as YYYYMMDD in UTC', () => {
    assert.equal(dateKey(new Date('2026-08-08T12:00:00Z')), '20260808');
    assert.equal(dateKey(new Date('2026-01-02T23:59:00Z')), '20260102');
  });
});

describe('parseScoreboard: eng.1 (live-captured, scheduled + DraftKings odds)', () => {
  const { events, skipped } = parseScoreboard(eng1Raw, 'eng.1');

  it('parses one scheduled fixture without skipping', () => {
    assert.equal(events.length, 1);
    assert.equal(skipped, 0);
    const e = events[0];
    assert.equal(e.id, '401879301');
    assert.equal(e.league, 'eng.1');
    assert.equal(e.date, '2026-08-21T19:00Z');
    assert.equal(e.status.state, 'pre');
    assert.equal(e.status.name, 'STATUS_SCHEDULED');
    assert.equal(e.status.normalized, null);
  });

  it('reads teams home/away with abbreviations and zeroed scores', () => {
    const e = events[0];
    assert.equal(e.home.abbreviation, 'ARS');
    assert.equal(e.away.abbreviation, 'COV');
    assert.equal(e.home.score, 0);
    assert.equal(e.away.score, 0);
  });

  it('reads DraftKings odds with open AND close lines, decimal', () => {
    const e = events[0];
    assert.equal(e.odds.provider, 'DraftKings');
    // moneyline: home -600 close, draw +650 close, away +1400 close
    approx(e.odds.moneyline.home.open, americanToDecimal('-750'));
    approx(e.odds.moneyline.home.close, 1.1667);
    approx(e.odds.moneyline.draw.close, 7.5);
    approx(e.odds.moneyline.away.close, americanToDecimal('+1400'));
    // totals
    assert.equal(e.odds.totals.line, 2.5);
    approx(e.odds.totals.over.close, americanToDecimal('-180'));
    approx(e.odds.totals.under.close, 2.4);
    // spread
    approx(e.odds.spread.home.open, 2.2);
  });

  it('is reported as an upcoming fixture, not settleable yet', () => {
    assert.equal(upcomingFixtures(events).length, 1);
    assert.equal(settledMatches(events).length, 0);
    assert.equal(resultPayload(events[0]), null);
  });
});

describe('parseScoreboard: usa.1 finished match (live-captured)', () => {
  const { events, skipped } = parseScoreboard(usa1Raw, 'usa.1');
  const settled = settledMatches(events);

  it('parses the finished match with scores and goal events', () => {
    assert.equal(events.length, 1);
    assert.equal(skipped, 0);
    assert.equal(settled.length, 1);
    const e = settled[0];
    assert.equal(e.status.normalized, 'FT');
    assert.equal(e.status.completed, true);
    assert.equal(e.home.abbreviation, 'NE');
    assert.equal(e.away.abbreviation, 'HOU');
    assert.equal(e.home.score, 0);
    assert.equal(e.away.score, 2);
    assert.equal(e.details.length, 4);
  });

  it('builds the exact result contract lib/settlement.js consumes', () => {
    assert.deepEqual(resultPayload(settled[0]), { matchStatus: 'FT', goalsHome: 0, goalsAway: 2 });
  });

  it('is not an upcoming fixture', () => {
    assert.equal(upcomingFixtures(events).length, 0);
  });
});

describe('parseScoreboard: defensive parsing', () => {
  it('handles an empty events array as legitimate emptiness', () => {
    const { events, skipped } = parseScoreboard({ events: [] }, 'eng.1');
    assert.equal(events.length, 0);
    assert.equal(skipped, 0);
  });

  it('counts malformed events instead of crashing or pretending', () => {
    const raw = { events: [null, { id: '1' }, { id: '2', competitions: [{ competitors: [] }] }] };
    const { events, skipped } = parseScoreboard(raw, 'eng.1');
    assert.equal(events.length, 0);
    assert.equal(skipped, 3);
  });

  it('returns null odds when the competition has no odds block', () => {
    const raw = {
      events: [
        {
          id: '9',
          date: '2026-08-21T19:00Z',
          competitions: [
            {
              status: { type: { state: 'pre', name: 'STATUS_SCHEDULED' } },
              competitors: [
                { homeAway: 'home', team: { displayName: 'Arsenal', abbreviation: 'ARS' }, score: '0' },
                { homeAway: 'away', team: { displayName: 'Coventry', abbreviation: 'COV' }, score: '0' },
              ],
            },
          ],
        },
      ],
    };
    const { events } = parseScoreboard(raw, 'eng.1');
    assert.equal(events[0].odds, null);
  });
});
