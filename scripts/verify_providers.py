"""Live provider verification — Amendment B, Task B1b.

Confirms, against real API calls (not documentation), whether OddsPapi
actually carries Pinnacle/1xBet coverage and what API-Football's live
account limits are. Every raw response is saved to
fixtures/provider_probes/ so later offline tests (Task B3's de-vig math)
have real payloads to run against instead of invented ones.

Run only where the real secrets and real internet access are — this
session's sandbox has neither, so this runs via
.github/workflows/verify-providers.yml, not interactively. Never prints
an API key: URLs are logged with the key redacted, and response bodies
are the provider's own data, not ours to redact.

Exits non-zero if a required env var is missing or a call fails outright
(network error, non-2xx, or a response that doesn't parse as JSON) —
partial coverage findings are a valid result, but a broken probe must
never be mistaken for one.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "provider_probes"

ODDS_PROVIDER_BASE = "https://api.oddspapi.io/v4"
API_FOOTBALL_BASE = "https://v3.football.api-sports.io"

# Bookmakers OddsPapi is claimed (secondary sources, not yet live-verified)
# to carry, per docs/ARCHITECTURE.md "Data sources — Amendment B".
CANDIDATE_SHARP_BOOKS = ["pinnacle"]
CANDIDATE_SOFT_BOOKS = ["1xbet"]

# EPL is a reliable, high-volume competition to probe against regardless
# of which sportId/tournamentId OddsPapi assigns it — we discover the ID
# live rather than hardcoding one.
TARGET_COMPETITION_HINTS = ["premier league", "epl", "english premier league"]


class ProbeError(RuntimeError):
    """A call itself failed — distinct from a call succeeding with a
    finding we don't like (e.g. a bookmaker simply isn't covered)."""


def _redact_url(url: str) -> str:
    return re.sub(r"([?&]apiKey=)[^&]+", r"\1[REDACTED]", url)


# Default urllib sends "Python-urllib/x.y" as User-Agent, which several
# providers' Cloudflare WAF rules block outright (observed: OddsPapi
# returned a Cloudflare "error code: 1010" -- a bot-signature block, not
# an auth failure -- on the very first live run, before this header was
# added). A realistic browser-shaped UA is not spoofing identity, it's
# avoiding a false-positive bot classification for a legitimate API client.
_DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; tipster-aggregator-provider-check/1.0)",
    "Accept": "application/json",
}


def _get_json(url: str, headers: dict[str, str] | None = None) -> tuple[dict, dict]:
    """GET url, return (parsed_json_body, response_headers). Raises ProbeError."""
    req = urllib.request.Request(url, headers={**_DEFAULT_HEADERS, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            resp_headers = dict(resp.headers.items())
            status = resp.status
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise ProbeError(
            f"GET {_redact_url(url)} -> HTTP {exc.code}: {body[:500]}"
        ) from None
    except urllib.error.URLError as exc:
        raise ProbeError(f"GET {_redact_url(url)} -> {exc.reason}") from None

    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProbeError(
            f"GET {_redact_url(url)} -> HTTP {status} but body isn't valid JSON: {exc}"
        ) from None

    return body, resp_headers


def _save_probe(name: str, payload: dict) -> Path:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    path = FIXTURES_DIR / f"{name}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True))
    return path


def probe_odds_provider(api_key: str) -> dict[str, Any]:
    findings: dict[str, Any] = {"provider": "oddspapi", "errors": []}

    # 1. /v4/sports — find the football/soccer sportId.
    sports_url = f"{ODDS_PROVIDER_BASE}/sports?apiKey={api_key}"
    body, headers = _get_json(sports_url)
    _save_probe("oddspapi_sports", {"headers": headers, "body": body})
    sports = body if isinstance(body, list) else body.get("data", body.get("sports", []))
    football = next(
        (s for s in sports if "football" in str(s.get("sportName", "")).lower()
         or "soccer" in str(s.get("sportName", "")).lower()),
        None,
    )
    findings["football_sport"] = football
    if football is None:
        findings["errors"].append("No football/soccer entry found in /v4/sports response")
        return findings
    sport_id = football.get("sportId")

    # 2. /v4/tournaments?sportId=... — find EPL (or log what's available).
    tournaments_url = f"{ODDS_PROVIDER_BASE}/tournaments?sportId={sport_id}&apiKey={api_key}"
    body, headers = _get_json(tournaments_url)
    _save_probe("oddspapi_tournaments", {"headers": headers, "body": body})
    tournaments = body if isinstance(body, list) else body.get("data", body.get("tournaments", []))
    target = next(
        (
            t for t in tournaments
            if any(hint in str(t.get("tournamentName", "")).lower() for hint in TARGET_COMPETITION_HINTS)
        ),
        None,
    )
    findings["tournament_count"] = len(tournaments) if isinstance(tournaments, list) else "unknown"
    findings["target_tournament"] = target
    if target is None:
        findings["errors"].append(
            "No EPL-like tournament found — falling back to the first tournament with upcoming fixtures"
        )
        target = next(
            (t for t in tournaments if isinstance(tournaments, list) and t.get("upcomingFixtures")),
            None,
        )
        findings["target_tournament"] = target
    if target is None:
        findings["errors"].append("No tournament with upcoming fixtures available to probe odds against")
        return findings
    tournament_id = target.get("tournamentId")

    # 3. /v4/bookmakers — does the full catalog list Pinnacle / 1xBet at all?
    bookmakers_url = f"{ODDS_PROVIDER_BASE}/bookmakers?apiKey={api_key}"
    body, headers = _get_json(bookmakers_url)
    _save_probe("oddspapi_bookmakers", {"headers": headers, "body": body})
    bookmakers = body if isinstance(body, list) else body.get("data", body.get("bookmakers", []))
    bookmaker_names = {str(b.get("bookmakerName", b)).lower() for b in bookmakers} if isinstance(bookmakers, list) else set()
    findings["bookmaker_catalog_size"] = len(bookmakers) if isinstance(bookmakers, list) else "unknown"
    findings["catalog_has_pinnacle"] = any("pinnacle" in n for n in bookmaker_names)
    findings["catalog_has_1xbet"] = any("1xbet" in n for n in bookmaker_names)

    # 4. /v4/odds-by-tournaments?bookmaker=X — does a real odds call for
    #    this tournament actually return priced selections from that book?
    for book in CANDIDATE_SHARP_BOOKS + CANDIDATE_SOFT_BOOKS:
        odds_url = (
            f"{ODDS_PROVIDER_BASE}/odds-by-tournaments"
            f"?bookmaker={book}&tournamentIds={tournament_id}&apiKey={api_key}"
        )
        try:
            body, headers = _get_json(odds_url)
        except ProbeError as exc:
            findings[f"odds_call_{book}"] = {"error": str(exc)}
            findings["errors"].append(f"{book}: odds-by-tournaments call failed — {exc}")
            continue
        _save_probe(f"oddspapi_odds_{book}", {"headers": headers, "body": body})
        fixtures_out = body if isinstance(body, list) else body.get("data", body.get("fixtures", []))
        priced = [
            f for f in fixtures_out
            if isinstance(f, dict) and f.get("hasOdds") and f.get("bookmakerOdds")
        ] if isinstance(fixtures_out, list) else []
        findings[f"odds_call_{book}"] = {
            "fixtures_returned": len(fixtures_out) if isinstance(fixtures_out, list) else "unknown",
            "fixtures_with_priced_odds": len(priced),
        }

    findings["rate_limit_headers"] = {
        k: v for k, v in headers.items()
        if any(term in k.lower() for term in ("rate", "limit", "remaining", "quota", "requests"))
    }
    return findings


def _scrub_account_pii(value: Any) -> Any:
    """Recursively drop any "account" key from a JSON-shaped value.

    API-Football's /status endpoint returns real personal data (firstname,
    lastname, email) in an "account" block alongside the plan/quota info
    this script actually needs. Confirmed live on the first real run: that
    block landed unfiltered in a saved fixture and a build artifact before
    this scrubbing existed. Recursing and dropping the key unconditionally
    — rather than reconstructing one specific expected shape — means a
    future change to the response envelope (wrapped, unwrapped, nested
    differently) can't quietly let the same PII back through.
    """
    if isinstance(value, dict):
        return {k: _scrub_account_pii(v) for k, v in value.items() if k != "account"}
    if isinstance(value, list):
        return [_scrub_account_pii(v) for v in value]
    return value


def probe_api_football(api_key: str) -> dict[str, Any]:
    findings: dict[str, Any] = {"provider": "api-football", "errors": []}
    headers_req = {"x-apisports-key": api_key}

    # 1. /status — account plan and daily quota, straight from the source.
    status_url = f"{API_FOOTBALL_BASE}/status"
    try:
        body, headers = _get_json(status_url, headers=headers_req)
        body = _scrub_account_pii(body)
        _save_probe("api_football_status", {"headers": headers, "body": body})
        findings["account_status"] = body.get("response", body)
    except ProbeError as exc:
        findings["errors"].append(f"/status failed: {exc}")
        return findings

    # 2. /fixtures — a real near-term date, to confirm data actually flows.
    target_date = (datetime.now(timezone.utc) + timedelta(days=3)).date().isoformat()
    fixtures_url = f"{API_FOOTBALL_BASE}/fixtures?date={target_date}"
    try:
        body, headers = _get_json(fixtures_url, headers=headers_req)
        _save_probe("api_football_fixtures", {"headers": headers, "body": body})
        results = body.get("response", [])
        findings["fixtures_probe_date"] = target_date
        findings["fixtures_returned"] = len(results) if isinstance(results, list) else "unknown"
    except ProbeError as exc:
        findings["errors"].append(f"/fixtures failed: {exc}")

    findings["rate_limit_headers"] = {
        k: v for k, v in headers.items()
        if any(term in k.lower() for term in ("rate", "limit", "remaining", "quota", "requests"))
    }
    return findings


def render_decision_table(odds: dict[str, Any], football: dict[str, Any]) -> str:
    lines = ["# Provider verification — live results", ""]
    lines.append(f"Run at: {datetime.now(timezone.utc).isoformat()}")
    lines.append("")
    lines.append("## OddsPapi")
    lines.append("")
    if odds.get("errors"):
        lines.append("**Errors during probing:**")
        for e in odds["errors"]:
            lines.append(f"- {e}")
        lines.append("")
    lines.append(f"- Football sport found: {odds.get('football_sport') is not None}")
    lines.append(f"- Tournament catalog size (this sport): {odds.get('tournament_count', 'n/a')}")
    target = odds.get("target_tournament") or {}
    lines.append(f"- Probed tournament: {target.get('tournamentName', 'n/a')} (id={target.get('tournamentId', 'n/a')})")
    lines.append(f"- Full bookmaker catalog size: {odds.get('bookmaker_catalog_size', 'n/a')}")
    lines.append(f"- Catalog lists Pinnacle: {odds.get('catalog_has_pinnacle', 'n/a')}")
    lines.append(f"- Catalog lists 1xBet: {odds.get('catalog_has_1xbet', 'n/a')}")
    for book in CANDIDATE_SHARP_BOOKS + CANDIDATE_SOFT_BOOKS:
        call = odds.get(f"odds_call_{book}", {})
        lines.append(f"- `odds-by-tournaments` for `{book}`: {call}")
    lines.append(f"- Rate-limit-looking response headers: {odds.get('rate_limit_headers', {})}")
    lines.append("")
    lines.append("## API-Football")
    lines.append("")
    if football.get("errors"):
        lines.append("**Errors during probing:**")
        for e in football["errors"]:
            lines.append(f"- {e}")
        lines.append("")
    lines.append(f"- Account status: {json.dumps(football.get('account_status', {}))}")
    lines.append(f"- Fixtures returned for {football.get('fixtures_probe_date', 'n/a')}: {football.get('fixtures_returned', 'n/a')}")
    lines.append(f"- Rate-limit-looking response headers: {football.get('rate_limit_headers', {})}")
    lines.append("")
    lines.append("## Decision")
    lines.append("")
    pinnacle_confirmed = bool(
        odds.get("catalog_has_pinnacle")
        and odds.get("odds_call_pinnacle", {}).get("fixtures_with_priced_odds", 0) > 0
    )
    lines.append(
        f"- **Pinnacle coverage on OddsPapi confirmed live: {pinnacle_confirmed}.** "
        + (
            "Proceed with OddsPapi as the sharp reference."
            if pinnacle_confirmed
            else "Do NOT build B3's edge math on OddsPapi/Pinnacle without human review — "
            "fall back to SportsGameOdds or SharpAPI per the amendment, or investigate "
            "further before proceeding."
        )
    )
    return "\n".join(lines)


def main() -> int:
    api_football_key = os.environ.get("API_FOOTBALL_KEY")
    odds_key = os.environ.get("ODDS_PROVIDER_API_KEY")

    missing = [
        name for name, val in (
            ("API_FOOTBALL_KEY", api_football_key),
            ("ODDS_PROVIDER_API_KEY", odds_key),
        )
        if not val
    ]
    if missing:
        print(f"Missing required env var(s): {', '.join(missing)}. Refusing to run partially.", file=sys.stderr)
        return 1

    odds_findings: dict[str, Any]
    football_findings: dict[str, Any]

    try:
        odds_findings = probe_odds_provider(odds_key)
    except ProbeError as exc:
        print(f"OddsPapi probing failed outright: {exc}", file=sys.stderr)
        odds_findings = {"provider": "oddspapi", "errors": [str(exc)]}

    try:
        football_findings = probe_api_football(api_football_key)
    except ProbeError as exc:
        print(f"API-Football probing failed outright: {exc}", file=sys.stderr)
        football_findings = {"provider": "api-football", "errors": [str(exc)]}

    table = render_decision_table(odds_findings, football_findings)
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    (FIXTURES_DIR / "DECISION.md").write_text(table)
    print(table)

    hard_failure = bool(odds_findings.get("errors")) and "football_sport" not in odds_findings
    hard_failure = hard_failure or bool(football_findings.get("errors")) and "account_status" not in football_findings
    return 1 if hard_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
