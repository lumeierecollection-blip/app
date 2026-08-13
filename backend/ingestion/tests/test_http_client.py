"""Tests for the shared HTTP client, against a real local server."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from ingestion.http_client import HttpError, get_json, redact_url


class FakeHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/ok":
            payload = json.dumps({"hello": "world"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-RateLimit-Remaining", "9")
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/rate-limited":
            payload = json.dumps(
                {"error": {"message": "slow down", "retryMs": 588}}
            ).encode()
            self.send_response(429)
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/not-json":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"not json at all")
        elif self.path == "/broken":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"{}")
        else:
            self.send_response(404)
            self.end_headers()


@pytest.fixture
def server():
    srv = HTTPServer(("127.0.0.1", 0), FakeHandler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv
    srv.shutdown()


def test_get_json_returns_body_and_headers(server):
    result = get_json(f"http://127.0.0.1:{server.server_port}/ok")
    assert result.body == {"hello": "world"}
    assert result.headers["X-RateLimit-Remaining"] == "9"
    assert result.status == 200


def test_get_json_extracts_retry_after_from_429_body(server):
    with pytest.raises(HttpError) as exc_info:
        get_json(f"http://127.0.0.1:{server.server_port}/rate-limited")
    assert exc_info.value.status == 429
    assert exc_info.value.retry_after_seconds == pytest.approx(0.588)


def test_get_json_raises_on_non_json_body(server):
    with pytest.raises(HttpError, match="isn't valid JSON"):
        get_json(f"http://127.0.0.1:{server.server_port}/not-json")


def test_get_json_raises_on_server_error(server):
    with pytest.raises(HttpError) as exc_info:
        get_json(f"http://127.0.0.1:{server.server_port}/broken")
    assert exc_info.value.status == 500


def test_redact_url_hides_api_key_and_key_params():
    assert redact_url("https://x.io/v4/odds?apiKey=SECRET123&x=1") == (
        "https://x.io/v4/odds?apiKey=[REDACTED]&x=1"
    )
    assert redact_url("https://x.io/v3/status?key=abc") == "https://x.io/v3/status?key=[REDACTED]"


def test_credential_never_appears_in_exception_message(server):
    """The URL in an exception must be redacted, not just the happy path."""
    url = f"http://127.0.0.1:{server.server_port}/broken?apiKey=leak-me-not"
    with pytest.raises(HttpError) as exc_info:
        get_json(url)
    assert "leak-me-not" not in str(exc_info.value)
