/**
 * Amendment E -- deterministic post -> selection extraction (Task E4).
 *
 * "No APIs" rules out the Anthropic extraction call, so this is a rule
 * parser: team mentions resolved against the fixtures the scan just fetched
 * from ESPN (so home/away/kickoff/competition are the true, matching values),
 * market keywords, and decimal odds. Everything that doesn't parse is
 * surfaced as `unparsed` reasons -- never silently dropped. Images are
 * reported unparsed (OCR is deliberately out of scope: at quality it's an
 * API). Confidence is assigned by rule (1.0 when a decimal odds token is
 * present, else 0.5), not by a model.
 *
 * The grammar is intentionally small and documented by the tests (see
 * fixtures/extract/tip_samples.json): "X to beat/win Y @ odds",
 * "over/under N goals", "BTTS yes/no", "draw". The seeded nickname table
 * below is the permanent "Man U / Man Utd / MUFC" tax -- grows over time,
 * never exhaustively promised.
 */

const TEAM_ALIASES = {
  'man utd': 'manchester united',
  'man u': 'manchester united',
  'manu': 'manchester united',
  'mufc': 'manchester united',
  'man city': 'manchester city',
  'mcfc': 'manchester city',
  'spurs': 'tottenham hotspur',
  'toon': 'newcastle united',
  'nufc': 'newcastle united',
  'wolves': 'wolverhampton wanderers',
  'lufc': 'leeds united',
  'reds': 'liverpool',
  'gunners': 'arsenal',
  'blues': 'chelsea',
  'coyg': 'arsenal',
  'yid army': 'tottenham hotspur',
};

export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Team mention forms: the canonical name, the abbreviation, and any seeded
 * nicknames that resolve to this team name. */
function mentionForms(teamName, abbreviation) {
  const canonical = teamName.toLowerCase();
  const forms = new Set([canonical, (abbreviation ?? '').toLowerCase()]);
  for (const [alias, resolved] of Object.entries(TEAM_ALIASES)) {
    if (resolved === canonical) forms.add(alias);
  }
  forms.delete('');
  return [...forms];
}

function indexOfAny(text, forms) {
  let best = -1;
  for (const form of forms) {
    const idx = text.search(new RegExp(`\\b${escapeRegExp(form)}\\b`, 'i'));
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

/** Fixtures whose home and away are both mentioned, ordered by first
 * mention in the text. Each carries the mention forms for direction
 * resolution. */
function matchFixtures(normalized, fixtures) {
  const matched = [];
  for (const fixture of fixtures) {
    if (!fixture?.home?.name || !fixture?.away?.name || !fixture?.date || !fixture?.id) continue;
    const homeForms = mentionForms(fixture.home.name, fixture.home.abbreviation);
    const awayForms = mentionForms(fixture.away.name, fixture.away.abbreviation);
    const homeIdx = indexOfAny(normalized, homeForms);
    const awayIdx = indexOfAny(normalized, awayForms);
    if (homeIdx === -1 || awayIdx === -1) continue;
    matched.push({ fixture, homeForms, awayForms, order: Math.min(homeIdx, awayIdx) });
  }
  matched.sort((a, b) => a.order - b.order);
  return matched;
}

/** Moneyline direction: the subject of a beat/win phrase, then a bare
 * "draw". No verb, no draw -> null (no moneyline pick for this fixture). */
function moneylinePick(normalized, m) {
  for (const [subjectForms, pick] of [
    [m.homeForms, 'home'],
    [m.awayForms, 'away'],
  ]) {
    for (const s of subjectForms) {
      const beaten = new RegExp(
        `\\b${escapeRegExp(s)}\\s+(?:to\\s+)?(?:beat|defeat|beats?)\\s+(?:against\\s+|over\\s+)?`,
        'i',
      );
      if (beaten.test(normalized)) return pick;
      const wins = new RegExp(`\\b${escapeRegExp(s)}\\s+(?:to\\s+)?(?:win|wins|winning)\\b`, 'i');
      if (wins.test(normalized)) return pick;
    }
  }
  if (/\bdraw\b/i.test(normalized)) return 'draw';
  return null;
}

const ODDS_RE = /\d{1,2}\.\d{2,3}/g;

/** First decimal odds token at/after `fromIndex`; falls back to the first
 * one anywhere in the text. */
function oddsAt(normalized, fromIndex) {
  ODDS_RE.lastIndex = fromIndex ?? 0;
  let match = ODDS_RE.exec(normalized);
  if (match) return Number(match[0]);
  ODDS_RE.lastIndex = 0;
  match = ODDS_RE.exec(normalized);
  return match ? Number(match[0]) : null;
}

function makePick(fixture, market, pick, line, claimedOdds) {
  return {
    home: fixture.home.name,
    away: fixture.away.name,
    competition: fixture.league,
    kickoffUtc: fixture.date,
    providerEventId: fixture.id,
    market,
    pick,
    line,
    claimedOdds,
    confidence: claimedOdds ? 1.0 : 0.5,
  };
}

/**
 * Parse one post's text against the tracked fixtures.
 *
 * @param {string} text raw post text
 * @param {Array} fixtures normalized ESPN events (upcoming fixtures from
 *   the same scan's fetch)
 * @param {{media?: boolean}} [opts] whether the post carried an image/other
 *   media (a text-less media post is an image slip -- recorded unparsed)
 * @returns {{picks: Array, unparsed: string[]}}
 */
export function extractPicks(text, fixtures, { media = false } = {}) {
  const normalized = normalizeText(text);
  const picks = [];
  const unparsed = [];

  if (!normalized) {
    unparsed.push(media ? 'post has media but no text' : 'empty post');
    return { picks, unparsed };
  }

  const matched = matchFixtures(normalized, fixtures);
  if (matched.length === 0) {
    unparsed.push('no tracked fixture matched in post text');
    return { picks, unparsed };
  }

  for (const m of matched) {
    const direction = moneylinePick(normalized, m);
    if (direction !== null) {
      picks.push(makePick(m.fixture, 'moneyline', direction, null, oddsAt(normalized, m.order)));
    }
  }

  const first = matched[0];
  for (const tm of normalized.matchAll(/\b(over|under)\s+(\d+(?:\.\d+)?)\b/g)) {
    picks.push(
      makePick(first.fixture, 'totals', tm[1], Number(tm[2]), oddsAt(normalized, tm.index + tm[0].length)),
    );
  }

  const btts =
    normalized.match(/\bbtts\s+(yes|no)\b/) ??
    normalized.match(/\bboth\s+teams\s+(?:to\s+)?score(?:\s+(yes|no))?/);
  if (btts) {
    picks.push(
      makePick(first.fixture, 'btts', btts[1] ?? 'yes', null, oddsAt(normalized, btts.index + btts[0].length)),
    );
  }

  if (picks.length === 0) unparsed.push('fixture matched but no market could be determined');
  return { picks, unparsed };
}
