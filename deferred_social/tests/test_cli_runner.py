"""Tests for the shared ingestion subprocess runner.

These spawn real child processes (small `python3 -c` scripts) instead of
mocking subprocess.run, so the timeout, environment-injection, and
redaction behavior is proven against an actual OS process rather than
against our own assumptions about what subprocess.run does.
"""

from __future__ import annotations

import os
import sys

import pytest

from cli_runner import (
    CliCommandError,
    CliEmptyOutputError,
    CliTimeoutError,
    run,
    run_with_retry,
)

PY = sys.executable


def test_run_returns_stdout_on_success():
    result = run([PY, "-c", "print('hello')"])
    assert result.stdout.strip() == "hello"


def test_run_raises_cli_command_error_on_nonzero_exit():
    with pytest.raises(CliCommandError) as exc_info:
        run([PY, "-c", "import sys; sys.exit(3)"])
    assert exc_info.value.returncode == 3


def test_run_raises_on_exit_zero_with_empty_stdout():
    """Exit 0 with nothing printed must be a failure, not zero results.

    This is the exact shape of silent credential expiry: the process exits
    cleanly but has nothing to say, and that must never be mistaken for
    "no new posts today."
    """
    with pytest.raises(CliEmptyOutputError):
        run([PY, "-c", "pass"])


def test_run_allows_empty_output_when_caller_opts_in():
    result = run([PY, "-c", "pass"], allow_empty_output=True)
    assert result.stdout == ""


def test_run_raises_cli_timeout_error_on_slow_command():
    with pytest.raises(CliTimeoutError):
        run([PY, "-c", "import time; time.sleep(5)"], timeout=0.3)


def test_credentials_reach_child_env_but_never_parent_env():
    marker = "MY_TEST_SECRET_ENV_VAR"
    assert marker not in os.environ

    result = run(
        [PY, "-c", f"import os; print(os.environ.get('{marker}', 'MISSING'))"],
        env_overrides={marker: "s3cr3t-value"},
    )

    assert result.stdout.strip() == "s3cr3t-value"
    assert marker not in os.environ  # parent process env is never mutated


def test_stderr_is_redacted_against_credential_values():
    # The script reads the secret back out of its own child-process env at
    # runtime (as a real CLI echoing an invalid token would) rather than
    # embedding the literal value in the script text — the latter would be
    # a credential-in-argv mistake, which cli_runner correctly rejects.
    result = run(
        [
            PY,
            "-c",
            "import os, sys; "
            "sys.stderr.write('token=' + os.environ['TWITTER_CT0'] + ' seen'); "
            "sys.stderr.flush(); print('ok')",
        ],
        env_overrides={"TWITTER_CT0": "abc123leak"},
    )
    assert "abc123leak" not in result.stderr
    assert "[REDACTED]" in result.stderr


def test_redaction_applies_to_exception_stderr_on_command_error():
    """A credential must never appear even inside a raised error's stderr."""
    with pytest.raises(CliCommandError) as exc_info:
        run(
            [
                PY,
                "-c",
                "import os, sys; "
                "sys.stderr.write('auth failed for ' + os.environ['TWITTER_CT0']); "
                "sys.exit(1)",
            ],
            env_overrides={"TWITTER_CT0": "abc123leak"},
        )
    assert "abc123leak" not in exc_info.value.stderr
    assert "abc123leak" not in str(exc_info.value)


def test_secret_in_argv_is_rejected_before_spawning():
    """A caller mistake — putting a credential in argv, not env — fails loud."""
    with pytest.raises(ValueError, match="argv"):
        run(
            [PY, "-c", "print('should never run')", "abc123leak"],
            env_overrides={"TWITTER_CT0": "abc123leak"},
        )


def test_run_with_retry_succeeds_after_transient_failure(tmp_path):
    counter_file = tmp_path / "attempts"
    counter_file.write_text("0")

    script = (
        "import pathlib, sys\n"
        f"p = pathlib.Path(r'{counter_file}')\n"
        "n = int(p.read_text()) + 1\n"
        "p.write_text(str(n))\n"
        "if n < 2:\n"
        "    sys.exit(1)\n"
        "print('succeeded on attempt', n)\n"
    )

    result = run_with_retry(
        [PY, "-c", script],
        attempts=3,
        backoff_seconds=0.01,
    )
    assert "succeeded on attempt 2" in result.stdout


def test_run_with_retry_raises_after_exhausting_attempts():
    with pytest.raises(CliCommandError):
        run_with_retry(
            [PY, "-c", "import sys; sys.exit(1)"],
            attempts=2,
            backoff_seconds=0.01,
        )
