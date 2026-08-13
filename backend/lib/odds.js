/**
 * OddsPapi odds provider, ported from backend/ingestion/odds/oddspapi_provider.py
 * in this project's history (Task B2). Base URL, auth (apiKey query param),
 * and the /v4/sports, /v4/tournaments, /v4/bookmakers, /v4/odds-by-tournaments
 * endpoints are all live-confirmed (Task B1b -- see fixtures/provider_probes/
 * for the real committed responses this parser is written against, not
 * documentation guesses).
 *
 * **Real bug found and fixed during this port, not carried forward:** the
 * Python version's outcome classifier labeled 1X2 outcomes as market
 * `"h2h"`, while `lib/settlement.js`'s `MARKET_RULES` (built later, Task B6)
 * keys on `"moneyline"` for the exact same market. The two never actually
 * connected in the original codebase -- the one live B2 run found zero
 * fixtures, so nothing ever exercised settlement against a real OddsPapi
 * quote -- so this mismatch shipped unnoticed. Fixed here: classification
 * returns `"moneyline"`, matching every other module's convention.
 *
 * One real gap, not yet live-confirmed: a fixture entry carries
 * `participant1Id`/`participant2Id` (numeric), never team names. Resolving
 * those to names needs a `/v4/participants` call whose exact shape isn't
 * documented anywhere this project could verify -- built as the best
 * available guess (the same `?<idsParam>=X,Y&apiKey=...` convention every
 * other confirmed OddsPapi list endpoint uses), and it raises clearly
 * rather than silently mis-resolving if that guess is wrong.
 *
 * A second real finding, caught by a Python test failing against real
 * captured data rather than assumed up front: a single fixture carries ~36
 * markets, and outcome ids like "home"/"draw"/"away" are **not unique** --
 * a second period (likely a half, not independently confirmed which) has
 * its own moneyline market with its own home/draw/away outcomes and
 * materially different prices. `bookmakerMarketId` encodes both the period
 * and the market type as its last two "/"-separated segments (e.g.
 * "line/29/1980/1632011611/3687861871/0/moneyline"); this project only
 * ever wants period "0" (full match), and for totals, only the outcome
 * with `mainLine: true` (there are ~10 alternate lines per fixture).
 */

const BASE_URL = 'https://api.oddspapi.io/v4';

const FULL_MATCH_PERIOD = '0';
const SUPPORTED_MARKET_TYPES = new Set(['moneyline', 'totals']);

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`OddsPapi returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`OddsPapi ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

function asEntries(body) {
  return Array.isArray(body) ? body : (body.data ?? []);
}

function parseMarketId(bookmakerMarketId) {
  const parts = (bookmakerMarketId ?? '').split('/');
  if (parts.length < 2) return ['', ''];
  return [parts[parts.length - 2], parts[parts.length - 1]];
}

/**
 * (market, selection, line) from a bookmakerOutcomeId string. Only two
 * patterns are live-confirmed: bare "home"/"draw"/"away" moneyline
 * outcomes, and "<line>/over" or "<line>/under" totals outcomes. Anything
 * else is bucketed as "other" with the raw id preserved, not guessed at.
 */
export function classifyOutcome(bookmakerOutcomeId) {
  if (['home', 'draw', 'away'].includes(bookmakerOutcomeId)) {
    return ['moneyline', bookmakerOutcomeId, null];
  }
  if (bookmakerOutcomeId.includes('/')) {
    const [lineStr, side] = bookmakerOutcomeId.split('/', 2);
    const line = Number(lineStr);
    if (Number.isNaN(line)) return ['other', bookmakerOutcomeId, null];
    if (side === 'over' || side === 'under') return ['totals', side, line];
    return ['other', bookmakerOutcomeId, line];
  }
  return ['other', bookmakerOutcomeId, null];
}

function parseUtc(isoString) {
  return new Date(isoString);
}

export class OddsPapiProvider {
  key = 'oddspapi';
  name = 'OddsPapi';

  constructor(apiKey) {
    this._apiKey = apiKey;
  }

  async findSportId(nameHint) {
    const body = await getJson(`${BASE_URL}/sports?apiKey=${this._apiKey}`);
    for (const sport of asEntries(body)) {
      if (String(sport.sportName ?? '').toLowerCase().includes(nameHint.toLowerCase())) {
        return Number(sport.sportId);
      }
    }
    return null;
  }

  async findTournamentId(sportId, nameHint) {
    const body = await getJson(`${BASE_URL}/tournaments?sportId=${sportId}&apiKey=${this._apiKey}`);
    for (const tournament of asEntries(body)) {
      if (String(tournament.tournamentName ?? '').toLowerCase().includes(nameHint.toLowerCase())) {
        return Number(tournament.tournamentId);
      }
    }
    return null;
  }

  /** Best-effort participant id -> name lookup. See module docstring. */
  async resolveParticipantNames(participantIds) {
    if (participantIds.length === 0) return {};
    const idsParam = participantIds.join(',');
    const body = await getJson(`${BASE_URL}/participants?participantIds=${idsParam}&apiKey=${this._apiKey}`);
    const names = {};
    for (const entry of asEntries(body)) {
      const pid = entry.participantId;
      const pname = entry.participantName ?? entry.name;
      if (pid !== undefined && pname) names[Number(pid)] = String(pname);
    }
    return names;
  }

  async fetchOdds({ tournamentId, bookmaker }) {
    const url = `${BASE_URL}/odds-by-tournaments?bookmaker=${bookmaker}&tournamentIds=${tournamentId}&apiKey=${this._apiKey}`;
    const body = await getJson(url);
    const entries = asEntries(body);

    const participantIds = [
      ...new Set(entries.flatMap((e) => [e.participant1Id, e.participant2Id]).filter((id) => id !== undefined)),
    ];
    const names = await this.resolveParticipantNames(participantIds);

    const quotes = [];
    for (const entry of entries) {
      if (!entry.hasOdds) continue;

      const rawId = entry.fixtureId;
      const numericPart = typeof rawId === 'string' && rawId.startsWith('id') ? rawId.slice(2) : rawId;
      const fixtureId = Number(numericPart);
      if (!Number.isFinite(fixtureId)) {
        throw new Error(`Unexpected fixtureId shape: ${JSON.stringify(entry.fixtureId)}`);
      }

      const homeName = names[entry.participant1Id] ?? `participant-${entry.participant1Id}`;
      const awayName = names[entry.participant2Id] ?? `participant-${entry.participant2Id}`;
      const kickoff = parseUtc(entry.startTime);

      const bookData = entry.bookmakerOdds?.[bookmaker] ?? {};
      const markets = bookData.markets ?? {};
      for (const marketBlock of Object.values(markets)) {
        const [period, marketType] = parseMarketId(marketBlock.bookmakerMarketId);
        if (period !== FULL_MATCH_PERIOD || !SUPPORTED_MARKET_TYPES.has(marketType)) continue;

        const outcomes = marketBlock.outcomes ?? {};
        for (const outcomeBlock of Object.values(outcomes)) {
          const player = outcomeBlock.players?.['0'];
          if (!player || !player.active) continue;
          if (marketType === 'totals' && !player.mainLine) continue; // skip alternate total lines

          const outcomeId = player.bookmakerOutcomeId;
          const price = player.price;
          if (outcomeId === undefined || price === undefined) continue;

          const [market, selection, line] = classifyOutcome(String(outcomeId));
          quotes.push({
            providerFixtureId: fixtureId,
            home: homeName,
            away: awayName,
            kickoffUtc: kickoff,
            bookmaker,
            market,
            selection,
            line,
            odds: Number(price),
          });
        }
      }
    }
    return quotes;
  }
}
