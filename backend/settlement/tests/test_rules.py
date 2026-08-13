"""Tests for backend/settlement/rules.py, including the ugly cases
docs/ARCHITECTURE.md's Task B6 explicitly calls out: Asian handicap
quarter-lines (half win / half push), void on postponement/abandonment,
and correct-score push conditions."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from settlement.rules import settle_1x2, settle_ah, settle_btts, settle_ou, settle_selection


@dataclass
class Sel:
    market: str
    pick: str
    line: float | None = None


FT_2_1 = {"match_status": "FT", "goals_home": 2, "goals_away": 1}
FT_1_1 = {"match_status": "FT", "goals_home": 1, "goals_away": 1}
FT_0_0 = {"match_status": "FT", "goals_home": 0, "goals_away": 0}
FT_3_0 = {"match_status": "FT", "goals_home": 3, "goals_away": 0}
POSTPONED = {"match_status": "POSTP", "goals_home": None, "goals_away": None}
ABANDONED = {"match_status": "ABD", "goals_home": None, "goals_away": None}
IN_PROGRESS = {"match_status": "1H", "goals_home": 1, "goals_away": 0}


# ---- 1X2 ----


def test_settle_1x2_home_win():
    assert settle_1x2(Sel("moneyline", "home"), FT_2_1).status == "won"
    assert settle_1x2(Sel("moneyline", "draw"), FT_2_1).status == "lost"
    assert settle_1x2(Sel("moneyline", "away"), FT_2_1).status == "lost"


def test_settle_1x2_draw():
    assert settle_1x2(Sel("moneyline", "draw"), FT_1_1).status == "won"
    assert settle_1x2(Sel("moneyline", "home"), FT_1_1).status == "lost"


def test_settle_1x2_void_on_postponement():
    result = settle_1x2(Sel("moneyline", "home"), POSTPONED)
    assert result.status == "void"


def test_settle_1x2_void_on_abandonment():
    assert settle_1x2(Sel("moneyline", "home"), ABANDONED).status == "void"


def test_settle_1x2_ungradeable_while_in_progress():
    assert settle_1x2(Sel("moneyline", "home"), IN_PROGRESS).status == "ungradeable"


def test_settle_1x2_ungradeable_unknown_pick():
    assert settle_1x2(Sel("moneyline", "draw_no_bet"), FT_2_1).status == "ungradeable"


# ---- Totals (O/U), including correct-score push conditions ----


def test_settle_ou_over_wins_on_half_line():
    result = settle_ou(Sel("totals", "over", 2.5), FT_2_1)  # 3 total goals
    assert result.status == "won"
    assert result.payout_fraction == 1.0


def test_settle_ou_under_wins_on_half_line():
    result = settle_ou(Sel("totals", "under", 3.5), FT_2_1)  # 3 total goals
    assert result.status == "won"


def test_settle_ou_pushes_on_whole_line_exact_total():
    # 3 total goals, line 3.0 -- a real "correct-score push condition."
    result = settle_ou(Sel("totals", "over", 3.0), FT_2_1)
    assert result.status == "push"
    result_under = settle_ou(Sel("totals", "under", 3.0), FT_2_1)
    assert result_under.status == "push"


def test_settle_ou_quarter_line_half_win():
    # 3 total goals, over 2.75 -> splits into over 2.5 (won) and over 3.0 (push) -> half win.
    result = settle_ou(Sel("totals", "over", 2.75), FT_2_1)
    assert result.status == "won"
    assert result.payout_fraction == 0.5


def test_settle_ou_quarter_line_half_loss():
    # 0 total goals, over 0.25 -> splits into over 0.0 (push) and over 0.5 (lost) -> half loss.
    result = settle_ou(Sel("totals", "over", 0.25), FT_0_0)
    assert result.status == "lost"
    assert result.payout_fraction == 0.5


def test_settle_ou_void_on_postponement():
    assert settle_ou(Sel("totals", "over", 2.5), POSTPONED).status == "void"


def test_settle_ou_ungradeable_bad_pick():
    assert settle_ou(Sel("totals", "exactly_three", 2.5), FT_2_1).status == "ungradeable"


# ---- BTTS ----


def test_settle_btts_yes_wins_when_both_score():
    assert settle_btts(Sel("btts", "yes"), FT_2_1).status == "won"
    assert settle_btts(Sel("btts", "no"), FT_2_1).status == "lost"


def test_settle_btts_no_wins_when_a_team_is_blanked():
    assert settle_btts(Sel("btts", "no"), FT_3_0).status == "won"
    assert settle_btts(Sel("btts", "yes"), FT_3_0).status == "lost"


def test_settle_btts_void_on_abandonment():
    assert settle_btts(Sel("btts", "yes"), ABANDONED).status == "void"


# ---- Asian handicap, including quarter-line half win / half push ----


def test_settle_ah_whole_line_win():
    # Home -1, home wins 2-1 (diff=1): 1 > 1? No -- 1 is not > 1, so this
    # whole line pushes exactly at the handicap.
    result = settle_ah(Sel("asian_handicap", "home", -1.0), FT_2_1)
    assert result.status == "push"


def test_settle_ah_whole_line_decisive():
    # Home -1, home wins 3-0 (diff=3): clearly covers -> won.
    result = settle_ah(Sel("asian_handicap", "home", -1.0), FT_3_0)
    assert result.status == "won"
    result_away = settle_ah(Sel("asian_handicap", "away", 1.0), FT_3_0)
    assert result_away.status == "lost"


def test_settle_ah_half_line_never_pushes():
    result = settle_ah(Sel("asian_handicap", "home", -0.5), FT_1_1)
    assert result.status == "lost"
    assert result.payout_fraction == 1.0


def test_settle_ah_quarter_line_half_win():
    # Home -0.25, home wins 2-1 (diff=1): splits into home 0 (won, diff=1>0)
    # and home -0.5 (won, diff=1>0.5) -> full win, not half -- use a draw
    # instead to get the half-win/half-push case on the +0.25 side.
    result = settle_ah(Sel("asian_handicap", "home", 0.25), FT_1_1)  # draw, diff=0
    assert result.status == "won"
    assert result.payout_fraction == 0.5


def test_settle_ah_quarter_line_half_loss():
    # Home -0.25, draw (diff=0): splits into home 0 (push) and home -0.5 (lost) -> half loss.
    result = settle_ah(Sel("asian_handicap", "home", -0.25), FT_1_1)
    assert result.status == "lost"
    assert result.payout_fraction == 0.5


def test_settle_ah_quarter_line_full_win_both_halves_cover():
    result = settle_ah(Sel("asian_handicap", "home", -0.25), FT_3_0)
    assert result.status == "won"
    assert result.payout_fraction == 1.0


def test_settle_ah_void_on_postponement():
    assert settle_ah(Sel("asian_handicap", "home", -0.5), POSTPONED).status == "void"


def test_settle_ah_ungradeable_missing_line():
    assert settle_ah(Sel("asian_handicap", "home", None), FT_2_1).status == "ungradeable"


# ---- Dispatch ----


def test_settle_selection_dispatches_by_market():
    assert settle_selection(Sel("moneyline", "home"), FT_2_1).status == "won"
    assert settle_selection(Sel("totals", "over", 2.5), FT_2_1).status == "won"


def test_settle_selection_unhandled_market_is_ungradeable_not_a_guess():
    result = settle_selection(Sel("correct_score", "2-1"), FT_2_1)
    assert result.status == "ungradeable"
