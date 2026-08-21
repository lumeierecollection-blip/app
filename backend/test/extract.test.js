import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractPicks, normalizeText } from '../lib/extract.js';

const fixtureFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'extract', 'tip_samples.json');
const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
const trackedFixture = fixture.fixture;
const fixtures = [trackedFixture];

test('fixture file is present and self-consistent', () => {
  assert.ok(trackedFixture.home.name);
  assert.ok(trackedFixture.away.name);
  assert.ok(trackedFixture.date);
});

for (const sample of fixture.samples) {
  test(`extractPicks: ${sample.id}`, () => {
    const { picks, unparsed } = extractPicks(sample.text, fixtures, { media: sample.media });
    assert.deepEqual(
      picks.map(({ home, away, competition, kickoffUtc, providerEventId, market, pick, line, claimedOdds, confidence }) => ({
        home,
        away,
        competition,
        kickoffUtc,
        providerEventId,
        market,
        pick,
        line,
        claimedOdds,
        confidence,
      })),
      sample.expectPicks.map((p) => ({
        home: trackedFixture.home.name,
        away: trackedFixture.away.name,
        competition: trackedFixture.league,
        kickoffUtc: trackedFixture.date,
        providerEventId: trackedFixture.id,
        ...p,
      })),
    );
    assert.deepEqual(unparsed, sample.expectUnparsed);
  });
}

test('normalizeText lowercases, collapses whitespace, and unifies dashes', () => {
  assert.equal(normalizeText('  Arsenal   to  beat  Coventry — draw  '), 'arsenal to beat coventry - draw');
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText(null), '');
});

test('extractPicks never matches fixtures whose date or id is missing', () => {
  const broken = [{ id: 'x', league: 'eng.1', date: null, home: { name: 'Arsenal' }, away: { name: 'Coventry City' } }];
  const { picks, unparsed } = extractPicks('Arsenal to beat Coventry City @ 1.35', broken);
  assert.deepEqual(picks, []);
  assert.deepEqual(unparsed, ['no tracked fixture matched in post text']);
});

test('extractPicks ignores a fixture where only one team is mentioned', () => {
  const { picks } = extractPicks('Arsenal are looking strong this season.', fixtures);
  assert.deepEqual(picks, []);
});

test('extractPicks takes the odds token nearest the market phrase, not an earlier unrelated number', () => {
  const text = '3 goals in the last 5. over 2.5 - Arsenal vs Coventry City @ 1.72';
  const { picks } = extractPicks(text, fixtures);
  const totals = picks.find((p) => p.market === 'totals');
  assert.equal(totals.pick, 'over');
  assert.equal(totals.line, 2.5);
  assert.equal(totals.claimedOdds, 1.72, 'must skip the earlier "5." token');
});
