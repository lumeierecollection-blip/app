import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  fetchTelegramPreview,
  parseTelegramHtml,
  generateFixturePulse,
} from '../lib/sources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function sampleHtml() {
  const raw = await readFile(join(__dirname, '..', '..', 'fixtures', 'telegram_preview', 'sample.json'), 'utf8');
  return JSON.parse(raw).html;
}

test('parseTelegramHtml extracts id, real timestamp, and cleaned text', async () => {
  const posts = parseTelegramHtml('tipsterdemo', await sampleHtml());
  assert.equal(posts.length, 2, 'media-only message must be skipped');

  assert.equal(posts[0].id, 'tg-tipsterdemo/101');
  assert.equal(posts[0].channel, 'tipsterdemo');
  assert.equal(posts[0].postedAt, '2026-08-20T17:30:00.000Z');
  assert.equal(posts[0].text, 'Arsenal to beat Chelsea @ 1.85, over 2.5 goals too');
  assert.equal(posts[0].url, 'https://t.me/tipsterdemo/101');

  // Markup stripped, entities decoded, <br> -> newline.
  assert.equal(posts[1].text, 'Man Utd win & BTTS yes @ 2.10\njoin @vipchannel');
  assert.equal(posts[1].postedAt, '2026-08-21T09:12:00.000Z');
});

test('fetchTelegramPreview parses the preview page via a fake fetch', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push(url);
    return {
      ok: true,
      text: async () => await sampleHtml(),
    };
  };
  const posts = await fetchTelegramPreview(['tipsterdemo'], { fetchFn });
  assert.equal(calls[0], 'https://t.me/s/tipsterdemo');
  assert.equal(posts.length, 2);
});

test('fetchTelegramPreview survives a failing channel without losing the others', async () => {
  const fetchFn = async (url) => {
    if (url.includes('privatechannel')) throw new Error('404');
    return { ok: true, text: async () => await sampleHtml() };
  };
  const posts = await fetchTelegramPreview(['privatechannel', 'tipsterdemo'], { fetchFn });
  assert.equal(posts.length, 2);
  assert.ok(posts.every((p) => p.channel === 'tipsterdemo'));
});

test('fetchTelegramPreview ignores non-OK responses', async () => {
  const posts = await fetchTelegramPreview(['gone'], {
    fetchFn: async () => ({ ok: false, text: async () => '' }),
  });
  assert.deepEqual(posts, []);
});

function fixtureEvent(id, dateIso, home, away, odds) {
  return {
    id,
    league: 'eng.1',
    date: dateIso,
    status: { state: 'pre', name: 'STATUS_SCHEDULED', completed: false, normalized: null },
    home: { name: home, abbreviation: null, score: null },
    away: { name: away, abbreviation: null, score: null },
    odds: odds ?? null,
  };
}

test('generateFixturePulse renders real fixture data, sorted, capped, zero picks', () => {
  const now = () => new Date('2026-08-21T10:00:00Z');
  const events = [
    fixtureEvent('301', '2026-08-23T14:00:00Z', 'Everton', 'Brighton'),
    fixtureEvent('300', '2026-08-22T16:30:00Z', 'Arsenal', 'Chelsea', {
      provider: 'DraftKings',
      moneyline: {
        home: { open: 1.8, close: 1.85 },
        draw: { open: 3.5, close: 3.6 },
        away: { open: 4.6, close: 4.2 },
      },
    }),
  ];
  const pulse = generateFixturePulse(events, { now });
  assert.equal(pulse.length, 2);
  assert.equal(pulse[0].id, 'pulse-300', 'earlier kickoff first');
  assert.equal(pulse[0].handle, 'fixture-pulse');
  assert.equal(pulse[0].selectionCount, 0);
  assert.equal(pulse[0].postedAt, '2026-08-22T16:30:00Z');
  assert.match(pulse[0].text, /Arsenal vs Chelsea/);
  assert.match(pulse[0].text, /DraftKings: home 1\.85 · draw 3\.6 · away 4\.2/, 'close prices preferred over open');
  assert.doesNotMatch(pulse[1].text, /home \d/, 'no odds block when the event has none');
});
