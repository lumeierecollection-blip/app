/**
 * The scan cycle server.js runs on a timer (Task D4). Ported in spirit
 * from backend/ingestion/odds/run_once.py in this project's history: fetch
 * fixtures, fetch sharp-book odds, match them, store, finalize closing
 * lines, sweep for settlement, rescore strategies.
 *
 * There is deliberately no "auto-detect edge from a second book" step
 * here: this project never built automated soft-book odds ingestion (no
 * confirmed South African bookmaker coverage on the odds API -- see
 * CLAUDE.md's Data sources section). The manual price check
 * (/api/manual-check) is the real, primary way a soft-book price enters
 * this system, not a fallback for a missing scanner.
 */

import { ApiFootballFixtureProvider, findMatchingProviderFixtureId } from './fixtures.js';
import { OddsPapiProvider } from './odds.js';
import { scoreStrategy } from './scoring.js';
import {
  fetchActiveStrategies,
  finalizeClosingLines,
  findPendingSelections,
  insertOddsSnapshot,
  loadSettledSelectionsForStrategy,
  recordIngestionHealth,
  upsertFixture,
  upsertStrategyScore,
} from './supabase.js';

const WINDOWS = { '30d': 30, '90d': 90, all: null };

export async function ingestFixturesAndOdds({
  apiFootballKey,
  oddsPapiKey,
  competition,
  bookmaker = 'pinnacle',
  daysAhead = 7,
}) {
  const fixtureProvider = new ApiFootballFixtureProvider(apiFootballKey);
  const oddsProvider = new OddsPapiProvider(oddsPapiKey);

  const today = new Date();
  const dateTo = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  let rawFixtures;
  try {
    rawFixtures = await fixtureProvider.fetchUpcomingFixtures({ competition, dateFrom: today, dateTo });
  } catch (err) {
    await recordIngestionHealth({ platform: 'api-football', status: 'error', detail: String(err.message) });
    throw err;
  }
  await recordIngestionHealth({
    platform: 'api-football',
    status: rawFixtures.length > 0 ? 'ok' : 'empty',
    detail: `${rawFixtures.length} fixture(s) for ${competition}`,
  });

  if (rawFixtures.length === 0) {
    return { fixturesProcessed: 0, snapshotsWritten: 0 };
  }

  const sportId = await oddsProvider.findSportId('soccer');
  const tournamentId = sportId === null ? null : await oddsProvider.findTournamentId(sportId, competition);

  let quotes = [];
  if (tournamentId !== null) {
    try {
      quotes = await oddsProvider.fetchOdds({ tournamentId, bookmaker });
      await recordIngestionHealth({
        platform: 'oddspapi',
        status: quotes.length > 0 ? 'ok' : 'empty',
        detail: `${quotes.length} quote(s) for ${competition}`,
      });
    } catch (err) {
      await recordIngestionHealth({ platform: 'oddspapi', status: 'error', detail: String(err.message) });
      throw err;
    }
  } else {
    await recordIngestionHealth({ platform: 'oddspapi', status: 'empty', detail: `no tournament match for ${competition}` });
  }

  let fixturesProcessed = 0;
  let snapshotsWritten = 0;
  for (const fixture of rawFixtures) {
    const fixtureId = await upsertFixture(fixture);
    fixturesProcessed += 1;

    const matchedProviderFixtureId = findMatchingProviderFixtureId(fixture, quotes);
    if (matchedProviderFixtureId === null) continue;

    const fixtureQuotes = quotes.filter((q) => q.providerFixtureId === matchedProviderFixtureId);
    for (const quote of fixtureQuotes) {
      await insertOddsSnapshot(fixtureId, quote);
      snapshotsWritten += 1;
    }
  }

  const closingLinesFlagged = await finalizeClosingLines();
  return { fixturesProcessed, snapshotsWritten, closingLinesFlagged };
}

/** Settlement sweep -- reports how many selections are waiting on a
 * result, but does not settle anything: no confirmed API-Football (or
 * other) endpoint for finished-fixture scores exists yet in this
 * project's history, so there is no real result source to call. This
 * stays an honest, visible gap rather than a fabricated fetch. */
export async function reportPendingSettlements(now = new Date()) {
  const cutoff = new Date(now.getTime() - 150 * 60 * 1000);
  const pending = await findPendingSelections(cutoff);
  return pending.length;
}

export async function rescoreAllStrategies(now = new Date()) {
  const strategyIds = await fetchActiveStrategies();
  let written = 0;
  for (const strategyId of strategyIds) {
    for (const [window, days] of Object.entries(WINDOWS)) {
      const windowStart = days === null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const selections = await loadSettledSelectionsForStrategy({ strategyId, windowStart });
      const result = scoreStrategy(selections, { now });
      await upsertStrategyScore({ strategyId, window, result, computedAt: now });
      written += 1;
    }
  }
  return written;
}
