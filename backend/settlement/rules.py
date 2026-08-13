"""Task B6 -- settlement rules. One versioned pure function per market,
each taking (selection, result_payload) and returning a SettlementOutcome
-- never guessing, and always returning `ungradeable` rather than a wrong
answer when the input doesn't cleanly resolve (docs/ARCHITECTURE.md §
"Settlement": "Anything unhandled -> ungradeable, ... Never guess a
settlement").

`result_payload`'s shape here is **this project's own normalized result
contract**, not a copy of any specific provider's raw response --
no session in this project has ever captured a real finished-fixture
score payload from API-Football to confirm its exact field names (Task
B1b's one captured `/fixtures` probe was a "date not on the free plan"
error, not real match data; see fixtures/provider_probes/api_football_fixtures.json).
Whatever ingestion eventually pulls real results is responsible for
mapping the provider's real shape onto this one -- same "confirm before
trusting" posture already applied to OddsPapi's unconfirmed
`/v4/participants` endpoint in Task B2.

    result_payload = {
        "match_status": str,   # this project's own normalized status --
                                # one of FINISHED_STATUSES or VOID_STATUSES
        "goals_home": int | None,
        "goals_away": int | None,
    }
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

RULE_VERSION = "v1"

FINISHED_STATUSES = {"FT", "AET", "PEN"}
VOID_STATUSES = {"POSTP", "ABD", "CANC", "AWD", "WO"}


@dataclass
class SettlementOutcome:
    status: str  # 'won' | 'lost' | 'void' | 'push' | 'ungradeable'
    payout_fraction: float = 1.0


class SettleableSelection(Protocol):
    market: str
    pick: str
    line: float | None


def _match_result(result_payload: dict[str, Any]) -> tuple[str | None, int | None, int | None]:
    return result_payload.get("match_status"), result_payload.get("goals_home"), result_payload.get("goals_away")


def _line_outcome(value: float, threshold: float) -> str:
    """'won' if value beats threshold, 'lost' if it falls short, 'push' on
    an exact tie -- the shared building block for both totals and Asian
    handicap settlement."""
    if value > threshold:
        return "won"
    if value < threshold:
        return "lost"
    return "push"


def _is_quarter_line(line: float) -> bool:
    """A quarter line (e.g. -0.25, +0.75) has a fractional part of .25 or
    .75, i.e. line*4 is an odd integer -- as opposed to a whole line
    (line*4 divisible by 4) or a half line (line*4 even but not
    divisible by 4)."""
    return round(line * 4) % 2 != 0


def _combine_half_outcomes(outcome_a: str, outcome_b: str) -> SettlementOutcome:
    """A quarter-line bet is, in practice, two equal-sized bets on the
    neighboring whole/half lines. Exactly one of the two components can
    ever push (the whole-number one); the other is always decisive."""
    pair = tuple(sorted((outcome_a, outcome_b)))
    combined = {
        ("won", "won"): SettlementOutcome("won", 1.0),
        ("push", "won"): SettlementOutcome("won", 0.5),
        ("push", "push"): SettlementOutcome("push", 1.0),
        ("lost", "push"): SettlementOutcome("lost", 0.5),
        ("lost", "lost"): SettlementOutcome("lost", 1.0),
    }.get(pair)
    if combined is None:
        raise AssertionError(f"impossible quarter-line outcome combination: {pair}")
    return combined


def _settle_split_line(value: float, line: float) -> SettlementOutcome:
    """Shared settlement math for any "value vs. line" market (totals,
    Asian handicap): splits a quarter line into its two neighboring
    lines and combines them; settles a whole/half line directly."""
    if _is_quarter_line(line):
        outcome_a = _line_outcome(value, line - 0.25)
        outcome_b = _line_outcome(value, line + 0.25)
        return _combine_half_outcomes(outcome_a, outcome_b)
    return SettlementOutcome(status=_line_outcome(value, line), payout_fraction=1.0)


def settle_1x2(selection: SettleableSelection, result_payload: dict[str, Any]) -> SettlementOutcome:
    status, goals_home, goals_away = _match_result(result_payload)
    if status in VOID_STATUSES:
        return SettlementOutcome("void")
    if status not in FINISHED_STATUSES or goals_home is None or goals_away is None:
        return SettlementOutcome("ungradeable")
    if selection.pick not in ("home", "draw", "away"):
        return SettlementOutcome("ungradeable")

    if goals_home > goals_away:
        actual = "home"
    elif goals_away > goals_home:
        actual = "away"
    else:
        actual = "draw"
    return SettlementOutcome("won" if selection.pick == actual else "lost")


def settle_ou(selection: SettleableSelection, result_payload: dict[str, Any]) -> SettlementOutcome:
    status, goals_home, goals_away = _match_result(result_payload)
    if status in VOID_STATUSES:
        return SettlementOutcome("void")
    if status not in FINISHED_STATUSES or goals_home is None or goals_away is None:
        return SettlementOutcome("ungradeable")
    if selection.pick not in ("over", "under") or selection.line is None:
        return SettlementOutcome("ungradeable")

    total_goals = goals_home + goals_away
    line = float(selection.line)
    if selection.pick == "over":
        value, effective_line = float(total_goals), line
    else:  # "under" -- negate both sides to reuse the same ">" logic
        value, effective_line = -float(total_goals), -line
    return _settle_split_line(value, effective_line)


def settle_btts(selection: SettleableSelection, result_payload: dict[str, Any]) -> SettlementOutcome:
    status, goals_home, goals_away = _match_result(result_payload)
    if status in VOID_STATUSES:
        return SettlementOutcome("void")
    if status not in FINISHED_STATUSES or goals_home is None or goals_away is None:
        return SettlementOutcome("ungradeable")
    if selection.pick not in ("yes", "no"):
        return SettlementOutcome("ungradeable")

    both_scored = goals_home > 0 and goals_away > 0
    won = both_scored if selection.pick == "yes" else not both_scored
    return SettlementOutcome("won" if won else "lost")


def settle_ah(selection: SettleableSelection, result_payload: dict[str, Any]) -> SettlementOutcome:
    status, goals_home, goals_away = _match_result(result_payload)
    if status in VOID_STATUSES:
        return SettlementOutcome("void")
    if status not in FINISHED_STATUSES or goals_home is None or goals_away is None:
        return SettlementOutcome("ungradeable")
    if selection.pick not in ("home", "away") or selection.line is None:
        return SettlementOutcome("ungradeable")

    pick_goals, opponent_goals = (goals_home, goals_away) if selection.pick == "home" else (goals_away, goals_home)
    diff = float(pick_goals - opponent_goals)
    # Win condition is pick_goals + line > opponent_goals, i.e. diff > -line.
    effective_line = -float(selection.line)
    return _settle_split_line(diff, effective_line)


MARKET_RULES = {
    "moneyline": settle_1x2,
    "totals": settle_ou,
    "btts": settle_btts,
    "asian_handicap": settle_ah,
}


def settle_selection(selection: SettleableSelection, result_payload: dict[str, Any]) -> SettlementOutcome:
    rule = MARKET_RULES.get(selection.market)
    if rule is None:
        return SettlementOutcome("ungradeable")
    return rule(selection, result_payload)
