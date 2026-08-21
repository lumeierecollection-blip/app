import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { settle1x2, settleAh, settleBtts, settleOu, settleSelection } from '../lib/settlement.js';

const sel = (market, pick, line = null) => ({ market, pick, line });

const FT_2_1 = { matchStatus: 'FT', goalsHome: 2, goalsAway: 1 };
const FT_1_1 = { matchStatus: 'FT', goalsHome: 1, goalsAway: 1 };
const FT_0_0 = { matchStatus: 'FT', goalsHome: 0, goalsAway: 0 };
const FT_3_0 = { matchStatus: 'FT', goalsHome: 3, goalsAway: 0 };
const POSTPONED = { matchStatus: 'POSTP', goalsHome: null, goalsAway: null };
const ABANDONED = { matchStatus: 'ABD', goalsHome: null, goalsAway: null };
const IN_PROGRESS = { matchStatus: '1H', goalsHome: 1, goalsAway: 0 };

describe('settle1x2', () => {
  it('settles a home win', () => {
    assert.equal(settle1x2(sel('moneyline', 'home'), FT_2_1).status, 'won');
    assert.equal(settle1x2(sel('moneyline', 'draw'), FT_2_1).status, 'lost');
    assert.equal(settle1x2(sel('moneyline', 'away'), FT_2_1).status, 'lost');
  });

  it('settles a draw', () => {
    assert.equal(settle1x2(sel('moneyline', 'draw'), FT_1_1).status, 'won');
    assert.equal(settle1x2(sel('moneyline', 'home'), FT_1_1).status, 'lost');
  });

  it('voids on postponement', () => {
    assert.equal(settle1x2(sel('moneyline', 'home'), POSTPONED).status, 'void');
  });

  it('voids on abandonment', () => {
    assert.equal(settle1x2(sel('moneyline', 'home'), ABANDONED).status, 'void');
  });

  it('is ungradeable while in progress', () => {
    assert.equal(settle1x2(sel('moneyline', 'home'), IN_PROGRESS).status, 'ungradeable');
  });

  it('is ungradeable for an unknown pick', () => {
    assert.equal(settle1x2(sel('moneyline', 'draw_no_bet'), FT_2_1).status, 'ungradeable');
  });
});

describe('settleOu', () => {
  it('settles over on a half line', () => {
    const result = settleOu(sel('totals', 'over', 2.5), FT_2_1); // 3 total goals
    assert.equal(result.status, 'won');
    assert.equal(result.payoutFraction, 1.0);
  });

  it('settles under on a half line', () => {
    assert.equal(settleOu(sel('totals', 'under', 3.5), FT_2_1).status, 'won');
  });

  it('pushes on a whole line exact total (correct-score push condition)', () => {
    assert.equal(settleOu(sel('totals', 'over', 3.0), FT_2_1).status, 'push');
    assert.equal(settleOu(sel('totals', 'under', 3.0), FT_2_1).status, 'push');
  });

  it('half-wins a quarter line', () => {
    // 3 total goals, over 2.75 -> splits into over 2.5 (won) and over 3.0 (push) -> half win.
    const result = settleOu(sel('totals', 'over', 2.75), FT_2_1);
    assert.equal(result.status, 'won');
    assert.equal(result.payoutFraction, 0.5);
  });

  it('half-loses a quarter line', () => {
    // 0 total goals, over 0.25 -> splits into over 0.0 (push) and over 0.5 (lost) -> half loss.
    const result = settleOu(sel('totals', 'over', 0.25), FT_0_0);
    assert.equal(result.status, 'lost');
    assert.equal(result.payoutFraction, 0.5);
  });

  it('voids on postponement', () => {
    assert.equal(settleOu(sel('totals', 'over', 2.5), POSTPONED).status, 'void');
  });

  it('is ungradeable for a bad pick', () => {
    assert.equal(settleOu(sel('totals', 'exactly_three', 2.5), FT_2_1).status, 'ungradeable');
  });
});

describe('settleBtts', () => {
  it('yes wins when both teams score', () => {
    assert.equal(settleBtts(sel('btts', 'yes'), FT_2_1).status, 'won');
    assert.equal(settleBtts(sel('btts', 'no'), FT_2_1).status, 'lost');
  });

  it('no wins when a team is blanked', () => {
    assert.equal(settleBtts(sel('btts', 'no'), FT_3_0).status, 'won');
    assert.equal(settleBtts(sel('btts', 'yes'), FT_3_0).status, 'lost');
  });

  it('voids on abandonment', () => {
    assert.equal(settleBtts(sel('btts', 'yes'), ABANDONED).status, 'void');
  });
});

describe('settleAh', () => {
  it('pushes exactly at the whole-line handicap', () => {
    // Home -1, home wins 2-1 (diff=1): not > 1, pushes.
    assert.equal(settleAh(sel('asian_handicap', 'home', -1.0), FT_2_1).status, 'push');
  });

  it('settles a decisive whole line', () => {
    const result = settleAh(sel('asian_handicap', 'home', -1.0), FT_3_0);
    assert.equal(result.status, 'won');
    assert.equal(settleAh(sel('asian_handicap', 'away', 1.0), FT_3_0).status, 'lost');
  });

  it('never pushes on a half line', () => {
    const result = settleAh(sel('asian_handicap', 'home', -0.5), FT_1_1);
    assert.equal(result.status, 'lost');
    assert.equal(result.payoutFraction, 1.0);
  });

  it('half-wins a quarter line', () => {
    // Home +0.25, draw (diff=0): splits into home 0 (push) and home +0.5 (won) -> half win.
    const result = settleAh(sel('asian_handicap', 'home', 0.25), FT_1_1);
    assert.equal(result.status, 'won');
    assert.equal(result.payoutFraction, 0.5);
  });

  it('half-loses a quarter line', () => {
    // Home -0.25, draw (diff=0): splits into home 0 (push) and home -0.5 (lost) -> half loss.
    const result = settleAh(sel('asian_handicap', 'home', -0.25), FT_1_1);
    assert.equal(result.status, 'lost');
    assert.equal(result.payoutFraction, 0.5);
  });

  it('fully wins a quarter line when both halves cover', () => {
    const result = settleAh(sel('asian_handicap', 'home', -0.25), FT_3_0);
    assert.equal(result.status, 'won');
    assert.equal(result.payoutFraction, 1.0);
  });

  it('voids on postponement', () => {
    assert.equal(settleAh(sel('asian_handicap', 'home', -0.5), POSTPONED).status, 'void');
  });

  it('is ungradeable with a missing line', () => {
    assert.equal(settleAh(sel('asian_handicap', 'home', null), FT_2_1).status, 'ungradeable');
  });
});

describe('settleSelection', () => {
  it('dispatches by market', () => {
    assert.equal(settleSelection(sel('moneyline', 'home'), FT_2_1).status, 'won');
    assert.equal(settleSelection(sel('totals', 'over', 2.5), FT_2_1).status, 'won');
  });

  it('is ungradeable, not a guess, for an unhandled market', () => {
    assert.equal(settleSelection(sel('correct_score', '2-1'), FT_2_1).status, 'ungradeable');
  });
});
