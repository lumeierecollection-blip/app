/**
 * Thin Supabase client wrapper (Task D3, Prompt 8). Not an ORM -- a
 * handful of `select`/`insert`/`rpc` calls, one function per query each
 * other module actually needs, matching the "small file per concern" style
 * of the rest of this backend. Schema: supabase/migrations/20260813000001_schema.sql.
 *
 * Closing-line and settlement rows are never deleted or overwritten by
 * anything here -- odds_snapshots is insert-only (finalize_closing_lines
 * only flips the is_closing_line flag, via a Postgres function, never
 * touches odds/line/selection), and settlements are inserted once per
 * selection (selection_id is the primary key).
 */

import { createClient } from '@supabase/supabase-js';

let client = null;

export function getClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must both be set -- refusing to run without real storage');
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

function orThrow(result, context) {
  if (result.error) {
    throw new Error(`Supabase error (${context}): ${result.error.message}`);
  }
  return result.data;
}

// -- fixtures -----------------------------------------------------------

/** Insert a fixture, or return the existing row's id if already known. */
export async function upsertFixture(fixture) {
  const data = orThrow(
    await getClient()
      .from('fixtures')
      .upsert(
        {
          provider_fixture_id: fixture.providerFixtureId,
          competition: fixture.competition,
          home: fixture.home,
          away: fixture.away,
          kickoff_utc: fixture.kickoffUtc,
        },
        { onConflict: 'provider_fixture_id' },
      )
      .select('id')
      .single(),
    'upsertFixture',
  );
  return data.id;
}

// -- odds_snapshots -------------------------------------------------------

/** Always an INSERT -- never call this to "correct" an earlier row. */
export async function insertOddsSnapshot(fixtureId, quote) {
  orThrow(
    await getClient()
      .from('odds_snapshots')
      .insert({
        fixture_id: fixtureId,
        bookmaker: quote.bookmaker,
        market: quote.market,
        selection: quote.selection,
        line: quote.line ?? null,
        odds: quote.odds,
      }),
    'insertOddsSnapshot',
  );
}

/** Flags the closing line for every fixture whose kickoff has passed.
 * Returns the number of rows newly flagged. */
export async function finalizeClosingLines() {
  const data = orThrow(await getClient().rpc('finalize_closing_lines'), 'finalizeClosingLines');
  return data;
}

/** Latest snapshot per selection for a fixture/market/bookmaker. */
export async function fetchLatestSharpQuotes({ fixtureId, market, bookmaker = 'pinnacle' }) {
  const data = orThrow(
    await getClient()
      .from('odds_snapshots')
      .select('selection, line, odds, captured_at')
      .eq('fixture_id', fixtureId)
      .eq('market', market)
      .eq('bookmaker', bookmaker)
      .order('captured_at', { ascending: false }),
    'fetchLatestSharpQuotes',
  );
  const latestBySelection = new Map();
  for (const row of data) {
    if (!latestBySelection.has(row.selection)) latestBySelection.set(row.selection, row);
  }
  return [...latestBySelection.values()].map((row) => ({
    selection: row.selection,
    line: row.line,
    odds: Number(row.odds),
    capturedAt: new Date(row.captured_at),
  }));
}

// -- ingestion_health -----------------------------------------------------

export async function recordIngestionHealth({ platform, status, detail = null }) {
  if (!['ok', 'empty', 'error'].includes(status)) {
    throw new Error(`invalid ingestion_health status: ${status}`);
  }
  orThrow(
    await getClient().from('ingestion_health').insert({ platform, status, detail }),
    'recordIngestionHealth',
  );
}

// -- selections / manual_checks --------------------------------------------

export async function insertSelection(selection) {
  const data = orThrow(
    await getClient()
      .from('selections')
      .insert({
        origin: selection.origin,
        fixture_id: selection.fixtureId ?? null,
        strategy_id: selection.strategyId ?? null,
        sport: selection.sport ?? 'soccer',
        competition: selection.competition,
        home: selection.home,
        away: selection.away,
        kickoff_utc: selection.kickoffUtc,
        market: selection.market,
        pick: selection.pick,
        line: selection.line ?? null,
        verified_odds: selection.verifiedOdds ?? null,
        verified_odds_source: selection.verifiedOddsSource ?? null,
        bookmaker: selection.bookmaker ?? null,
        fair_probability: selection.fairProbability ?? null,
        fair_odds: selection.fairOdds ?? null,
        edge: selection.edge ?? null,
      })
      .select('id')
      .single(),
    'insertSelection',
  );
  return data.id;
}

/** Stored regardless of whether the check passed the sanity gates or found
 * a real edge -- this table isn't a scratchpad. */
export async function recordManualCheck(result) {
  const data = orThrow(
    await getClient()
      .from('manual_checks')
      .insert({
        fixture_id: result.fixtureId,
        market: result.market,
        pick: result.pick,
        line: result.line,
        fair_probability: result.fairProbability,
        fair_odds: result.fairOdds,
        entered_odds: result.enteredOdds,
        entered_bookmaker: result.enteredBookmaker,
        edge: result.edge,
        stake_fraction: result.stakeFraction,
        checked_at: result.checkedAt,
      })
      .select('id')
      .single(),
    'recordManualCheck',
  );
  return data.id;
}

// -- settlement -------------------------------------------------------------

export async function findPendingSelections(cutoff) {
  const data = orThrow(
    await getClient().rpc('find_pending_selections', { cutoff: cutoff.toISOString() }),
    'findPendingSelections',
  );
  return data.map((row) => ({
    id: row.id,
    fixtureId: row.fixture_id,
    market: row.market,
    pick: row.pick,
    line: row.line,
  }));
}

export async function recordSettlement({ selectionId, status, payoutFraction, resultPayload, settledAt, ruleVersion }) {
  orThrow(
    await getClient()
      .from('settlements')
      .insert({
        selection_id: selectionId,
        status,
        payout_fraction: payoutFraction,
        result_payload: resultPayload,
        settled_at: settledAt,
        settlement_rule_version: ruleVersion,
      }),
    'recordSettlement',
  );
}

// -- scoring ------------------------------------------------------------

export async function fetchActiveStrategies() {
  const data = orThrow(
    await getClient().from('strategies').select('id').eq('active', true),
    'fetchActiveStrategies',
  );
  return data.map((row) => row.id);
}

export async function loadSettledSelectionsForStrategy({ strategyId, windowStart }) {
  const data = orThrow(
    await getClient().rpc('load_settled_selections_for_strategy', {
      p_strategy_id: strategyId,
      p_window_start: windowStart ? windowStart.toISOString() : null,
    }),
    'loadSettledSelectionsForStrategy',
  );
  return data.map((row) => ({
    status: row.status,
    oddsUsed: row.verified_odds === null ? null : Number(row.verified_odds),
    settledAt: row.settled_at,
    postId: row.post_id,
    payoutFraction: Number(row.payout_fraction),
    closingOdds: row.closing_odds === null ? null : Number(row.closing_odds),
  }));
}

export async function upsertStrategyScore({ strategyId, window, result, computedAt }) {
  orThrow(
    await getClient()
      .from('strategy_scores')
      .upsert(
        {
          strategy_id: strategyId,
          window,
          n_settled: result.nSettled,
          roi: result.roi,
          roi_ci_low: result.roiCiLow,
          roi_ci_high: result.roiCiHigh,
          hit_rate: result.hitRate,
          avg_odds: result.avgOdds,
          mean_clv: result.meanClv,
          pct_positive_clv: result.pctPositiveClv,
          longest_losing_run: result.longestLosingRun,
          computed_at: computedAt,
        },
        { onConflict: 'strategy_id,window' },
      ),
    'upsertStrategyScore',
  );
}

/** Every rated strategy's most recent score per window, for the
 * /api/strategies read endpoint. */
export async function fetchStrategyScores() {
  const data = orThrow(
    await getClient()
      .from('strategy_scores')
      .select('strategy_id, window, n_settled, roi, roi_ci_low, roi_ci_high, hit_rate, avg_odds, mean_clv, pct_positive_clv, longest_losing_run, computed_at, strategies(competition, market_class, source_book)')
      .order('roi_ci_low', { ascending: false }),
    'fetchStrategyScores',
  );
  return data;
}

/** Slips for the /api/slips read endpoint, most recently built first. */
export async function fetchSlips() {
  const data = orThrow(
    await getClient().from('slips').select('*').order('built_at', { ascending: false }),
    'fetchSlips',
  );
  return data;
}
