"""OddsPapi odds provider.

Base URL, auth (apiKey query param), and the /v4/sports, /v4/tournaments,
/v4/bookmakers, /v4/odds-by-tournaments endpoints are all live-confirmed
(Task B1b — see fixtures/provider_probes/ for the real committed
responses this parser is written against, not documentation guesses).

One real gap found by reading the live response, not assumed: a fixture
entry carries `participant1Id`/`participant2Id` (numeric), never team
names. Resolving those to names needs a `/v4/participants` call whose
exact shape is **not yet live-confirmed** — search results describe a
"GET participants" endpoint existing but not its parameters. Built as
the best available implementation, following the same
`?<idsParam>=X,Y&apiKey=...` convention every other confirmed OddsPapi
list endpoint uses, and will raise clearly (not silently mis-resolve) if
that guess is wrong. Confirm via the Task B2 end-to-end run and update
this note.

A second, more subtle real finding, caught by a test failing against the
real data rather than assumed up front: a single fixture carries ~36
markets, and outcome ids like "home"/"draw"/"away" are **not unique** —
period "1" (a different match segment, most likely a half — not
independently confirmed which) has its own moneyline market with its own
"home"/"draw"/"away" outcomes and materially different prices from
period "0" (the full match). `bookmakerMarketId` encodes both the period
and the market type as its last two "/"-separated segments (e.g.
"line/29/1980/1632011611/3687861871/0/moneyline"), and each outcome
additionally carries `mainLine: true/false` — but `mainLine` alone
doesn't disambiguate period, since period "1"'s moneyline outcomes are
*also* `mainLine: true`. Both signals are needed together: this project
only ever wants period "0" (full match), and among period-0 markets,
only the `mainLine` one for totals (there are ~10 alternate total lines
per fixture, all `mainLine: false`, which are out of scope for B2 — nice
to have later, not needed for the primary 1X2/O-U markets this project's
de-vig math (Task B3) targets).
"""

from __future__ import annotations

from datetime import datetime, timezone

from ..http_client import HttpError, get_json
from .models import RawOddsQuote
from .provider import OddsProvider

BASE_URL = "https://api.oddspapi.io/v4"

# The only period this project ever wants: the full match. See module
# docstring — period "1" markets share outcome ids with period "0" but
# price differently, so this filter is load-bearing, not decorative.
FULL_MATCH_PERIOD = "0"

# Market types this project currently ingests. spreads/teamTotal exist in
# the real data (confirmed) but nothing downstream (Task B3's de-vig
# math, docs/ARCHITECTURE.md's data model) uses them yet — scope stays
# to what's needed now, not everything available.
SUPPORTED_MARKET_TYPES = {"moneyline", "totals"}


def _parse_market_id(bookmaker_market_id: str) -> tuple[str, str]:
    """(period, market_type), the last two "/"-separated segments."""
    parts = bookmaker_market_id.split("/")
    if len(parts) < 2:
        return "", ""
    return parts[-2], parts[-1]


def _classify_outcome(bookmaker_outcome_id: str) -> tuple[str, str, float | None]:
    """(market, selection, line) from a bookmakerOutcomeId string.

    Only two patterns are live-confirmed (Task B1b probe data): the bare
    "home"/"draw"/"away" moneyline outcomes, and "<line>/over" or
    "<line>/under" totals outcomes. Anything else is bucketed as "other"
    with the raw id preserved as the selection, rather than guessed at.
    Caller is responsible for the period/mainLine/market-type filtering
    described in the module docstring — this function only interprets
    the outcome id string in isolation.
    """
    if bookmaker_outcome_id in ("home", "draw", "away"):
        return "h2h", bookmaker_outcome_id, None
    if "/" in bookmaker_outcome_id:
        line_str, _, side = bookmaker_outcome_id.partition("/")
        try:
            line = float(line_str)
        except ValueError:
            return "other", bookmaker_outcome_id, None
        if side in ("over", "under"):
            return "totals", side, line
        return "other", bookmaker_outcome_id, line
    return "other", bookmaker_outcome_id, None


class OddsPapiProvider(OddsProvider):
    key = "oddspapi"
    name = "OddsPapi"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def find_sport_id(self, name_hint: str) -> int | None:
        response = get_json(f"{BASE_URL}/sports?apiKey={self._api_key}")
        sports = response.body if isinstance(response.body, list) else response.body.get("data", [])
        for sport in sports:
            if name_hint.lower() in str(sport.get("sportName", "")).lower():
                return int(sport["sportId"])
        return None

    def find_tournament_id(self, sport_id: int, name_hint: str) -> int | None:
        response = get_json(f"{BASE_URL}/tournaments?sportId={sport_id}&apiKey={self._api_key}")
        tournaments = (
            response.body if isinstance(response.body, list) else response.body.get("data", [])
        )
        for tournament in tournaments:
            if name_hint.lower() in str(tournament.get("tournamentName", "")).lower():
                return int(tournament["tournamentId"])
        return None

    def resolve_participant_names(self, participant_ids: list[int]) -> dict[int, str]:
        """Best-effort participant id -> name lookup. See module docstring."""
        if not participant_ids:
            return {}
        ids_param = ",".join(str(i) for i in participant_ids)
        url = f"{BASE_URL}/participants?participantIds={ids_param}&apiKey={self._api_key}"
        response = get_json(url)
        entries = response.body if isinstance(response.body, list) else response.body.get("data", [])
        names: dict[int, str] = {}
        for entry in entries:
            pid = entry.get("participantId")
            pname = entry.get("participantName") or entry.get("name")
            if pid is not None and pname:
                names[int(pid)] = str(pname)
        return names

    def fetch_odds(self, *, tournament_id: int, bookmaker: str) -> list[RawOddsQuote]:
        url = (
            f"{BASE_URL}/odds-by-tournaments"
            f"?bookmaker={bookmaker}&tournamentIds={tournament_id}&apiKey={self._api_key}"
        )
        response = get_json(url)
        entries = response.body if isinstance(response.body, list) else response.body.get("data", [])

        participant_ids = sorted(
            {
                pid
                for entry in entries
                for pid in (entry.get("participant1Id"), entry.get("participant2Id"))
                if pid is not None
            }
        )
        names = self.resolve_participant_names(participant_ids)

        quotes: list[RawOddsQuote] = []
        for entry in entries:
            if not entry.get("hasOdds"):
                continue
            try:
                raw_id = entry["fixtureId"]
                # Live-confirmed shape: a string like "id1000001772221154" --
                # an "id" prefix over what is otherwise a plain integer.
                numeric_part = raw_id.removeprefix("id") if isinstance(raw_id, str) else raw_id
                fixture_id = int(numeric_part)
            except (KeyError, ValueError, TypeError) as exc:
                raise HttpError(f"Unexpected fixtureId shape: {entry.get('fixtureId')!r} ({exc})") from exc

            home_name = names.get(entry.get("participant1Id"), f"participant-{entry.get('participant1Id')}")
            away_name = names.get(entry.get("participant2Id"), f"participant-{entry.get('participant2Id')}")
            kickoff = _parse_utc(entry["startTime"])

            book_data = entry.get("bookmakerOdds", {}).get(bookmaker, {})
            markets = book_data.get("markets", {})
            for market_block in markets.values():
                period, market_type = _parse_market_id(market_block.get("bookmakerMarketId", ""))
                if period != FULL_MATCH_PERIOD or market_type not in SUPPORTED_MARKET_TYPES:
                    continue
                outcomes = market_block.get("outcomes", {})
                for outcome_block in outcomes.values():
                    players = outcome_block.get("players", {})
                    player = players.get("0")
                    if not player or not player.get("active"):
                        continue
                    if market_type == "totals" and not player.get("mainLine"):
                        continue  # skip alternate total lines, keep only the main one
                    outcome_id = player.get("bookmakerOutcomeId")
                    price = player.get("price")
                    if outcome_id is None or price is None:
                        continue
                    market, selection, line = _classify_outcome(str(outcome_id))
                    quotes.append(
                        RawOddsQuote(
                            provider_fixture_id=fixture_id,
                            home=home_name,
                            away=away_name,
                            kickoff_utc=kickoff,
                            bookmaker=bookmaker,
                            market=market,
                            selection=selection,
                            line=line,
                            odds=float(price),
                        )
                    )
        return quotes


def _parse_utc(iso_string: str) -> datetime:
    dt = datetime.fromisoformat(iso_string.replace("Z", "+00:00"))
    return dt.astimezone(timezone.utc)
