/**
 * API-Football fixture provider + fixture identity resolution, ported from
 * backend/ingestion/odds/api_football_provider.py and fixture_matching.py
 * in this project's history (Task B2).
 *
 * Base URL and auth header (`x-apisports-key`) are live-confirmed
 * (Task B1b). The exact response *shape* for a date range that actually
 * has fixtures is not yet live-confirmed from this project's own probes
 * (the B1b date happened to have zero matches, and B2's live run found a
 * real, still-not-fully-confirmed lead pointing at a free-tier date-range
 * restriction -- see docs/STATUS.md) -- built from API-Football's
 * long-stable, widely-documented v3 shape, and raises clearly rather than
 * silently mis-parsing if that shape doesn't hold.
 */

const BASE_URL = 'https://v3.football.api-sports.io';

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`API-Football returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`API-Football ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

function parseUtc(isoString) {
  return new Date(isoString);
}

export class ApiFootballFixtureProvider {
  key = 'api-football';
  name = 'API-Football';

  constructor(apiKey) {
    this._apiKey = apiKey;
    this._headers = { 'x-apisports-key': apiKey };
  }

  /** Look up a league's numeric id by name rather than hardcoding one --
   * resolved live and inspectable/loggable at call time. */
  async findLeagueId(name) {
    const url = `${BASE_URL}/leagues?search=${encodeURIComponent(name)}`;
    const body = await getJson(url, this._headers);
    const results = Array.isArray(body?.response) ? body.response : [];
    for (const entry of results) {
      const league = entry?.league ?? {};
      if (String(league.name ?? '').toLowerCase() === name.toLowerCase()) {
        return league.id ?? null;
      }
    }
    // Fall back to the first result if no exact (case-insensitive) match.
    if (results.length > 0) {
      return results[0]?.league?.id ?? null;
    }
    return null;
  }

  async fetchUpcomingFixtures({ competition, dateFrom, dateTo }) {
    const leagueId = await this.findLeagueId(competition);
    if (leagueId === null) {
      throw new Error(`No API-Football league found matching ${JSON.stringify(competition)}`);
    }

    const isoDate = (d) => d.toISOString().slice(0, 10);
    const season = dateFrom.getUTCFullYear();
    const url = `${BASE_URL}/fixtures?league=${leagueId}&from=${isoDate(dateFrom)}&to=${isoDate(dateTo)}&season=${season}`;
    const body = await getJson(url, this._headers);
    const entries = body?.response;
    if (!Array.isArray(entries)) {
      throw new Error(`Unexpected /fixtures response shape (no 'response' key): ${JSON.stringify(body).slice(0, 300)}`);
    }

    const fixtures = [];
    for (const entry of entries) {
      const fixtureBlock = entry.fixture;
      const teamsBlock = entry.teams;
      const leagueBlock = entry.league;
      if (!fixtureBlock?.id || !teamsBlock?.home?.name || !teamsBlock?.away?.name || !leagueBlock?.name) {
        throw new Error(`Unexpected fixture entry shape from API-Football: ${JSON.stringify(entry).slice(0, 300)}`);
      }
      fixtures.push({
        providerFixtureId: Number(fixtureBlock.id),
        competition: String(leagueBlock.name),
        home: String(teamsBlock.home.name),
        away: String(teamsBlock.away.name),
        kickoffUtc: parseUtc(fixtureBlock.date),
      });
    }
    return fixtures;
  }
}

// -- Fixture identity resolution -----------------------------------------
// API-Football and OddsPapi assign different internal ids to the same
// real-world match. This matches a canonical fixture (from API-Football)
// against the fixture identity carried on OddsPapi's quotes, using team
// names (normalized + alias-resolved) and kickoff proximity -- never a
// guess when the result is ambiguous.

export const DEFAULT_KICKOFF_TOLERANCE_MS = 3 * 60 * 60 * 1000;

// Seeded with real, well-known naming variants for clubs likely to appear
// in a major European league. Expected to grow -- a name not in here isn't
// a bug, it's the next entry to add once a real mismatch is observed.
export const TEAM_ALIASES = {
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'manchester utd': 'manchester united',
  'man city': 'manchester city',
  spurs: 'tottenham hotspur',
  tottenham: 'tottenham hotspur',
  wolves: 'wolverhampton wanderers',
  'nottm forest': 'nottingham forest',
  "nott'm forest": 'nottingham forest',
  brighton: 'brighton and hove albion',
  'brighton hove albion': 'brighton and hove albion',
  'west ham': 'west ham united',
  newcastle: 'newcastle united',
  leeds: 'leeds united',
};

const CLUB_SUFFIXES = /\b(fc|cf|afc|sc|cd|ac)\b/g;
const NON_ALPHANUMERIC = /[^a-z0-9 ]/g;
const EXTRA_WHITESPACE = /\s+/g;

/** Lowercase, strip accents/suffixes/punctuation, resolve aliases. */
export function normalizeTeamName(name) {
  const asciiName = name.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const lowered = asciiName.toLowerCase().trim();
  const noSuffix = lowered.replace(CLUB_SUFFIXES, '');
  const alnumOnly = noSuffix.replace(NON_ALPHANUMERIC, '');
  const collapsed = alnumOnly.replace(EXTRA_WHITESPACE, ' ').trim();
  return TEAM_ALIASES[collapsed] ?? collapsed;
}

function quoteMatches(canonical, quote, kickoffToleranceMs) {
  if (Math.abs(canonical.kickoffUtc.getTime() - quote.kickoffUtc.getTime()) > kickoffToleranceMs) {
    return false;
  }
  return normalizeTeamName(canonical.home) === normalizeTeamName(quote.home) &&
    normalizeTeamName(canonical.away) === normalizeTeamName(quote.away);
}

/**
 * The odds provider's fixture id for the quote(s) matching `canonical`.
 * `quotes` is typically many market-level quotes covering many fixtures --
 * this groups by providerFixtureId first, so a fixture with 5 quotes only
 * counts as one candidate.
 *
 * Returns null on zero matches (nothing corresponds to this fixture in
 * this tournament yet) or on more than one match (ambiguous -- refuse to
 * guess rather than silently pick wrong).
 */
export function findMatchingProviderFixtureId(canonical, quotes, kickoffToleranceMs = DEFAULT_KICKOFF_TOLERANCE_MS) {
  const candidatesById = new Map();
  for (const quote of quotes) {
    if (!candidatesById.has(quote.providerFixtureId)) candidatesById.set(quote.providerFixtureId, quote);
  }

  const matches = [];
  for (const [fixtureId, quote] of candidatesById) {
    if (quoteMatches(canonical, quote, kickoffToleranceMs)) matches.push(fixtureId);
  }
  return matches.length === 1 ? matches[0] : null;
}
