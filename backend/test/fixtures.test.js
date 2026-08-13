import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findMatchingProviderFixtureId, normalizeTeamName } from '../lib/fixtures.js';

const KICKOFF = new Date('2026-08-21T19:00:00Z');

function quote(providerFixtureId, home, away, overrides = {}) {
  return {
    providerFixtureId,
    home,
    away,
    kickoffUtc: KICKOFF,
    bookmaker: 'pinnacle',
    market: 'moneyline',
    selection: 'home',
    line: null,
    odds: 1.9,
    ...overrides,
  };
}

function canonicalFixture(home, away, overrides = {}) {
  return {
    providerFixtureId: 1,
    competition: 'Premier League',
    home,
    away,
    kickoffUtc: KICKOFF,
    ...overrides,
  };
}

describe('normalizeTeamName', () => {
  const cases = [
    ['Manchester United', 'manchester united'],
    ['Man Utd', 'manchester united'],
    ['Man United', 'manchester united'],
    ['Tottenham Hotspur FC', 'tottenham hotspur'],
    ['Spurs', 'tottenham hotspur'],
    ["Nott'm Forest", 'nottingham forest'],
    ['Brighton & Hove Albion', 'brighton and hove albion'],
    ['Wolves', 'wolverhampton wanderers'],
  ];
  for (const [raw, expected] of cases) {
    it(`resolves "${raw}" -> "${expected}"`, () => {
      assert.equal(normalizeTeamName(raw), expected);
    });
  }

  it('is idempotent on already-canonical names', () => {
    assert.equal(normalizeTeamName('Liverpool'), 'liverpool');
    assert.equal(normalizeTeamName('liverpool'), 'liverpool');
  });
});

describe('findMatchingProviderFixtureId', () => {
  it('succeeds on exact name and kickoff', () => {
    const canonical = canonicalFixture('Manchester United', 'Liverpool');
    const quotes = [quote(555, 'Manchester United', 'Liverpool')];
    assert.equal(findMatchingProviderFixtureId(canonical, quotes), 555);
  });

  it('succeeds through alias and suffix normalization', () => {
    const canonical = canonicalFixture('Man Utd', 'Spurs');
    const quotes = [quote(555, 'Manchester United FC', 'Tottenham Hotspur')];
    assert.equal(findMatchingProviderFixtureId(canonical, quotes), 555);
  });

  it('tolerates small kickoff drift between providers', () => {
    const canonical = canonicalFixture('Arsenal', 'Chelsea');
    const quotes = [quote(555, 'Arsenal', 'Chelsea', { kickoffUtc: new Date(KICKOFF.getTime() + 30 * 60 * 1000) })];
    assert.equal(findMatchingProviderFixtureId(canonical, quotes), 555);
  });

  it('rejects kickoff drift beyond tolerance', () => {
    const canonical = canonicalFixture('Arsenal', 'Chelsea');
    const quotes = [quote(555, 'Arsenal', 'Chelsea', { kickoffUtc: new Date(KICKOFF.getTime() + 6 * 60 * 60 * 1000) })];
    assert.equal(findMatchingProviderFixtureId(canonical, quotes), null);
  });

  it('returns null when nothing matches', () => {
    const canonical = canonicalFixture('Arsenal', 'Chelsea');
    const quotes = [quote(555, 'Manchester United', 'Liverpool')];
    assert.equal(findMatchingProviderFixtureId(canonical, quotes), null);
  });

  it('refuses to guess when ambiguous (two candidates both look like a match)', () => {
    const canonical = canonicalFixture('Arsenal', 'Chelsea');
    const quotes = [
      quote(555, 'Arsenal', 'Chelsea', { kickoffUtc: KICKOFF }),
      quote(556, 'Arsenal', 'Chelsea', { kickoffUtc: new Date(KICKOFF.getTime() + 5 * 60 * 1000) }),
    ];
    assert.equal(findMatchingProviderFixtureId(canonical, quotes), null);
  });

  it('groups many quotes per fixture as one candidate, not false ambiguity', () => {
    const canonical = canonicalFixture('Arsenal', 'Chelsea');
    const quotes = [
      quote(555, 'Arsenal', 'Chelsea', { selection: 'home', odds: 1.9 }),
      quote(555, 'Arsenal', 'Chelsea', { selection: 'draw', odds: 3.6 }),
      quote(555, 'Arsenal', 'Chelsea', { selection: 'away', odds: 4.2 }),
      quote(555, 'Arsenal', 'Chelsea', { market: 'totals', selection: 'over', line: 2.5, odds: 1.95 }),
    ];
    assert.equal(findMatchingProviderFixtureId(canonical, quotes), 555);
  });
});
