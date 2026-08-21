/**
 * Amendment E -- the key-less ESPN scoreboard adapter (Task E2). One free,
 * registration-free public endpoint replaces both the odds provider and the
 * fixtures/results provider the retired odds-market path paid for:
 *
 *   GET https://site.api.espn.com/apis/site/v2/sports/soccer/<league>/scoreboard
 *   GET .../scoreboard?dates=YYYYMMDD      (past dates, for results)
 *
 * Live-confirmed 2026-08-14 from this sandbox: the eng.1 response carries
 * fixtures with DraftKings odds (moneyline/total/spread, each with `open`
 * and `close` lines); the usa.1?dates=... response carries a finished match
 * (STATUS_FULL_TIME, per-team score, detail goal events).
 *
 * This is a consumer website, not a contract -- it changes shape. Every
 * parse is defensive (missing fields become null, never throws), and the
 * caller records one ingestion_health row per fetch so a shape change or
 * total outage is visible instead of looking like "no matches".
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const HTTP = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json',
};

/** Convert American odds to decimal. ESPN writes positives without the
 * leading "+" ("650" means +650), so a sign-less string is treated as
 * positive. Returns null for anything non-numeric or 0 (a pick-em). */
export function americanToDecimal(american) {
  if (american === null || american === undefined) return null;
  const raw = typeof american === 'string' ? american.trim().replace(/^\+/, '') : american;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

/** Map ESPN's status type name onto this project's normalized settlement
 * statuses (lib/settlement.js). Anything not finished or void returns null
 * -- the caller should not settle it yet. */
export function normalizeMatchStatus(statusName) {
  const map = {
    STATUS_FULL_TIME: 'FT',
    STATUS_FT_AET: 'AET',
    STATUS_FINAL_AET: 'AET',
    STATUS_FT_PEN: 'PEN',
    STATUS_FT_PENS: 'PEN',
    STATUS_FINAL_PEN: 'PEN',
    STATUS_POSTPONED: 'POSTP',
    STATUS_CANCELED: 'CANC',
    STATUS_CANCELLED: 'CANC',
    STATUS_ABANDONED: 'CANC',
    STATUS_AWARDED: 'AWD',
    STATUS_WALKOVER: 'WO',
  };
  return map[statusName] ?? null;
}

function asDecimalOdds(value) {
  return americanToDecimal(value?.odds ?? null);
}

/** Pick the useful odds block out of `competition.odds[]` -- the array is
 * one entry per provider; we take the first that actually carries a
 * moneyline. All odds converted to decimal, open and close preserved. */
function parseOdds(competition) {
  const blocks = Array.isArray(competition?.odds) ? competition.odds : [];
  const block = blocks.find((b) => b?.moneyline) ?? blocks[0];
  if (!block) return null;

  const ml = block.moneyline ?? {};
  const drawFallback = block.drawOdds?.moneyLine;
  const totals = block.total ?? {};
  const spread = block.pointSpread ?? {};

  return {
    provider: block.provider?.displayName ?? block.provider?.name ?? 'unknown',
    moneyline: {
      home: { open: asDecimalOdds(ml.home?.open), close: asDecimalOdds(ml.home?.close) },
      draw: { open: asDecimalOdds(ml.draw?.open), close: asDecimalOdds(ml.draw?.close) },
      away: { open: asDecimalOdds(ml.away?.open), close: asDecimalOdds(ml.away?.close) },
    },
    totals: {
      line: typeof block.overUnder === 'number' ? block.overUnder : null,
      over: { open: asDecimalOdds(totals.over?.open), close: asDecimalOdds(totals.over?.close) },
      under: { open: asDecimalOdds(totals.under?.open), close: asDecimalOdds(totals.under?.close) },
    },
    spread: spread.home && spread.away
      ? {
          home: { open: asDecimalOdds(spread.home?.open), close: asDecimalOdds(spread.home?.close) },
          away: { open: asDecimalOdds(spread.away?.open), close: asDecimalOdds(spread.away?.close) },
        }
      : null,
    // drawOdds.moneyLine is a fallback for responses where the moneyline
    // block has no draw key (some shapes only carry the top-level one).
    drawFallback,
  };
}

function parseCompetitor(competitor) {
  return {
    name: competitor?.team?.displayName ?? competitor?.team?.shortDisplayName ?? null,
    abbreviation: competitor?.team?.abbreviation ?? null,
    score: competitor?.score !== undefined && competitor?.score !== null ? Number(competitor.score) : null,
  };
}

/** One event -> normalized shape. Malformed events resolve to null (the
 * caller counts them against the fetch instead of pretending). */
function parseEvent(event, league) {
  const competition = event?.competitions?.[0];
  if (!event?.id || !competition) return null;
  const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;

  const statusType = competition.status?.type ?? {};
  const statusName = statusType.name ?? null;

  return {
    id: String(event.id),
    league,
    date: event.date ?? null,
    status: {
      state: statusType.state ?? null,
      name: statusName,
      completed: !!statusType.completed,
      normalized: normalizeMatchStatus(statusName),
    },
    home: parseCompetitor(home),
    away: parseCompetitor(away),
    details: Array.isArray(competition.details)
      ? competition.details.map((d) => ({
          clock: d?.clock?.displayValue ?? null,
          team: d?.team?.displayName ?? d?.team?.abbreviation ?? null,
          type: d?.type?.text ?? null,
          scoringPlay: !!d?.scoringPlay,
        }))
      : [],
    odds: parseOdds(competition),
  };
}

/** Parse a raw scoreboard response body. Returns the normalized events
 * array, plus counts so the caller can distinguish "empty" from "error". */
export function parseScoreboard(raw, league) {
  const events = Array.isArray(raw?.events) ? raw.events : [];
  const parsed = [];
  let skipped = 0;
  for (const event of events) {
    const normalized = parseEvent(event, league);
    if (normalized === null) skipped += 1;
    else parsed.push(normalized);
  }
  return { events: parsed, skipped };
}

/** Fetch one league/day of the public scoreboard endpoint.
 * @param {string} league ESPN league slug, e.g. 'eng.1'
 * @param {Date} [date] optional -- fetches that calendar day (needed for
 *   finished matches; the default "now" window is mostly upcoming fixtures).
 * @returns normalized events (see parseScoreboard)
 */
export async function fetchScoreboard({ league, date = null, fetchFn = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (!league) throw new Error('league is required');
  const url = new URL(`${BASE}/${league}/scoreboard`);
  if (date) url.searchParams.set('dates', dateKey(date));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchFn(url.toString(), { headers: HTTP, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`ESPN scoreboard ${league} returned HTTP ${response.status}`);
  }
  const raw = await response.json();
  return parseScoreboard(raw, league);
}

/** "2026-08-08" -> "20260808" (ESPN's dates param format, live-confirmed). */
export function dateKey(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** "20260808" -> a UTC Date for that calendar day (the inverse of
 * dateKey -- the pipeline groups pending selections by dateKey, then
 * re-fetches results per day). */
export function dateFromKey(key) {
  if (!/^\d{8}$/.test(key)) throw new Error(`invalid date key: ${key}`);
  return new Date(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T00:00:00.000Z`);
}

/** Upcoming fixtures (state 'pre') for a league. */
export function upcomingFixtures(events) {
  return events.filter((e) => e.status.state === 'pre');
}

/** Finished (or voided) matches -- those with a normalized settlement
 * status -- for a league. */
export function settledMatches(events) {
  return events.filter((e) => e.status.normalized !== null);
}

/** The normalized result contract lib/settlement.js consumes:
 * { matchStatus, goalsHome, goalsAway } -- null when the match has not
 * reached a settleable state or a score is missing. */
export function resultPayload(event) {
  if (event.status.normalized === null) return null;
  if (event.home.score === null || event.away.score === null) return null;
  return {
    matchStatus: event.status.normalized,
    goalsHome: event.home.score,
    goalsAway: event.away.score,
  };
}
