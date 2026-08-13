"""Shared HTTP client for REST-API provider adapters (OddsPapi, API-Football).

Distinct from cli_runner.py, which wraps subprocess calls to third-party
CLIs (Agent Reach's deferred social path) — this wraps plain HTTPS GET
calls to REST APIs. Encodes the lessons from the B1b live provider
verification (scripts/verify_providers.py):

- A realistic User-Agent is required. The first live OddsPapi call
  failed outright with a Cloudflare "error code: 1010" bot-block using
  urllib's default "Python-urllib/x.y" User-Agent.
- Rate-limit information isn't reliably in response headers. OddsPapi
  puts it in the 429 response body (`error.retryAfter`/`error.retryMs`);
  API-Football puts it in response headers (`x-ratelimit-*`) on every
  call. Callers need both paths available, not just one.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass

DEFAULT_TIMEOUT_SECONDS = 30.0

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; tipster-aggregator-ingestion/1.0)",
    "Accept": "application/json",
}

_URL_SECRET_PARAM = re.compile(r"([?&](?:apiKey|key)=)[^&]+", re.IGNORECASE)


def redact_url(url: str) -> str:
    return _URL_SECRET_PARAM.sub(r"\1[REDACTED]", url)


class HttpError(RuntimeError):
    """A call failed outright: timeout, non-2xx, or an unparseable body.

    retry_after_seconds is populated when the failure response carries
    its own retry hint (OddsPapi's 429 body) — callers doing backoff
    should prefer this over an improvised delay.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        body: str = "",
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True)
class JsonResponse:
    body: dict | list
    headers: dict[str, str]
    status: int


def _extract_retry_after(body_text: str) -> float | None:
    try:
        parsed = json.loads(body_text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    error = parsed.get("error") if isinstance(parsed, dict) else None
    if not isinstance(error, dict):
        return None
    retry_ms = error.get("retryMs")
    if isinstance(retry_ms, (int, float)):
        return retry_ms / 1000.0
    return None


def get_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> JsonResponse:
    """GET url and parse a JSON body. Raises HttpError on any failure.

    Never logs a credential: exceptions carry the URL with any apiKey/key
    query parameter redacted, never the raw value.
    """
    req = urllib.request.Request(url, headers={**DEFAULT_HEADERS, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            resp_headers = dict(resp.headers.items())
            status = resp.status
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise HttpError(
            f"GET {redact_url(url)} -> HTTP {exc.code}: {body_text[:500]}",
            status=exc.code,
            body=body_text,
            retry_after_seconds=_extract_retry_after(body_text),
        ) from None
    except urllib.error.URLError as exc:
        raise HttpError(f"GET {redact_url(url)} -> {exc.reason}") from None

    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HttpError(
            f"GET {redact_url(url)} -> HTTP {status} but body isn't valid JSON: {exc}",
            status=status,
        ) from None

    return JsonResponse(body=parsed, headers=resp_headers, status=status)
