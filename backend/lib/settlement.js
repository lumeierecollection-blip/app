/**
 * Task B6 -- settlement rules, ported from backend/settlement/rules.py in
 * this project's history. One versioned pure function per market, each
 * taking (selection, resultPayload) and returning a settlement outcome --
 * never guessing, and always returning `ungradeable` rather than a wrong
 * answer when the input doesn't cleanly resolve.
 *
 * `resultPayload`'s shape is this project's own normalized result contract,
 * not a copy of any specific provider's raw response -- no real
 * finished-fixture score payload has ever been captured in this project's
 * history (API-Football's one captured `/fixtures` probe was a "date not on
 * the free plan" error, not real match data).
 *
 *   resultPayload = {
 *     matchStatus: string,       // this project's own normalized status --
 *                                 // one of FINISHED_STATUSES or VOID_STATUSES
 *     goalsHome: number | null,
 *     goalsAway: number | null,
 *   }
 */

export const RULE_VERSION = 'v1';

export const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
export const VOID_STATUSES = new Set(['POSTP', 'ABD', 'CANC', 'AWD', 'WO']);

function matchResult(resultPayload) {
  return [resultPayload.matchStatus ?? null, resultPayload.goalsHome ?? null, resultPayload.goalsAway ?? null];
}

/** 'won' if value beats threshold, 'lost' if it falls short, 'push' on an
 * exact tie -- the shared building block for both totals and Asian handicap
 * settlement. */
function lineOutcome(value, threshold) {
  if (value > threshold) return 'won';
  if (value < threshold) return 'lost';
  return 'push';
}

/** A quarter line (e.g. -0.25, +0.75) has a fractional part of .25 or .75,
 * i.e. line*4 is an odd integer -- as opposed to a whole line (line*4
 * divisible by 4) or a half line (line*4 even but not divisible by 4). */
function isQuarterLine(line) {
  return Math.round(line * 4) % 2 !== 0;
}

/** A quarter-line bet is, in practice, two equal-sized bets on the
 * neighboring whole/half lines. Exactly one of the two components can ever
 * push (the whole-number one); the other is always decisive. */
function combineHalfOutcomes(outcomeA, outcomeB) {
  const pair = [outcomeA, outcomeB].sort().join(',');
  const combined = {
    'won,won': { status: 'won', payoutFraction: 1.0 },
    'push,won': { status: 'won', payoutFraction: 0.5 },
    'push,push': { status: 'push', payoutFraction: 1.0 },
    'lost,push': { status: 'lost', payoutFraction: 0.5 },
    'lost,lost': { status: 'lost', payoutFraction: 1.0 },
  }[pair];
  if (!combined) {
    throw new Error(`impossible quarter-line outcome combination: ${pair}`);
  }
  return combined;
}

/** Shared settlement math for any "value vs. line" market (totals, Asian
 * handicap): splits a quarter line into its two neighboring lines and
 * combines them; settles a whole/half line directly. */
function settleSplitLine(value, line) {
  if (isQuarterLine(line)) {
    const outcomeA = lineOutcome(value, line - 0.25);
    const outcomeB = lineOutcome(value, line + 0.25);
    return combineHalfOutcomes(outcomeA, outcomeB);
  }
  return { status: lineOutcome(value, line), payoutFraction: 1.0 };
}

export function settle1x2(selection, resultPayload) {
  const [status, goalsHome, goalsAway] = matchResult(resultPayload);
  if (VOID_STATUSES.has(status)) return { status: 'void', payoutFraction: 1.0 };
  if (!FINISHED_STATUSES.has(status) || goalsHome === null || goalsAway === null) {
    return { status: 'ungradeable', payoutFraction: 1.0 };
  }
  if (!['home', 'draw', 'away'].includes(selection.pick)) {
    return { status: 'ungradeable', payoutFraction: 1.0 };
  }

  let actual;
  if (goalsHome > goalsAway) actual = 'home';
  else if (goalsAway > goalsHome) actual = 'away';
  else actual = 'draw';
  return { status: selection.pick === actual ? 'won' : 'lost', payoutFraction: 1.0 };
}

export function settleOu(selection, resultPayload) {
  const [status, goalsHome, goalsAway] = matchResult(resultPayload);
  if (VOID_STATUSES.has(status)) return { status: 'void', payoutFraction: 1.0 };
  if (!FINISHED_STATUSES.has(status) || goalsHome === null || goalsAway === null) {
    return { status: 'ungradeable', payoutFraction: 1.0 };
  }
  if (!['over', 'under'].includes(selection.pick) || selection.line === null || selection.line === undefined) {
    return { status: 'ungradeable', payoutFraction: 1.0 };
  }

  const totalGoals = goalsHome + goalsAway;
  const line = selection.line;
  let value;
  let effectiveLine;
  if (selection.pick === 'over') {
    value = totalGoals;
    effectiveLine = line;
  } else {
    // "under" -- negate both sides to reuse the same ">" logic.
    value = -totalGoals;
    effectiveLine = -line;
  }
  return settleSplitLine(value, effectiveLine);
}

export function settleBtts(selection, resultPayload) {
  const [status, goalsHome, goalsAway] = matchResult(resultPayload);
  if (VOID_STATUSES.has(status)) return { status: 'void', payoutFraction: 1.0 };
  if (!FINISHED_STATUSES.has(status) || goalsHome === null || goalsAway === null) {
    return { status: 'ungradeable', payoutFraction: 1.0 };
  }
  if (!['yes', 'no'].includes(selection.pick)) {
    return { status: 'ungradeable', payoutFraction: 1.0 };
  }

  const bothScored = goalsHome > 0 && goalsAway > 0;
  const won = selection.pick === 'yes' ? bothScored : !bothScored;
  return { status: won ? 'won' : 'lost', payoutFraction: 1.0 };
}

export function settleAh(selection, resultPayload) {
  const [status, goalsHome, goalsAway] = matchResult(resultPayload);
  if (VOID_STATUSES.has(status)) return { status: 'void', payoutFraction: 1.0 };
  if (!FINISHED_STATUSES.has(status) || goalsHome === null || goalsAway === null) {
    return { status: 'ungradeable', payoutFraction: 1.0 };
  }
  if (!['home', 'away'].includes(selection.pick) || selection.line === null || selection.line === undefined) {
    return { status: 'ungradeable', payoutFraction: 1.0 };
  }

  const [pickGoals, opponentGoals] = selection.pick === 'home' ? [goalsHome, goalsAway] : [goalsAway, goalsHome];
  const diff = pickGoals - opponentGoals;
  // Win condition is pickGoals + line > opponentGoals, i.e. diff > -line.
  const effectiveLine = -selection.line;
  return settleSplitLine(diff, effectiveLine);
}

export const MARKET_RULES = {
  moneyline: settle1x2,
  totals: settleOu,
  btts: settleBtts,
  asian_handicap: settleAh,
};

export function settleSelection(selection, resultPayload) {
  const rule = MARKET_RULES[selection.market];
  if (!rule) return { status: 'ungradeable', payoutFraction: 1.0 };
  return rule(selection, resultPayload);
}
