"""Shared subprocess runner for third-party ingestion CLIs.

Every adapter (Twitter/X via twitter-cli, Reddit via rdt-cli, and any
opencli-based command) shells out to an upstream binary through this
module instead of calling subprocess directly. Treat every one of those
CLIs as hostile: it is third-party text output, not a library with a
stable contract. See docs/ARCHITECTURE.md, "Subprocess contract", for
the rules this module exists to enforce.
"""

from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass

DEFAULT_TIMEOUT_SECONDS = 120.0


class CliError(RuntimeError):
    """Base class for every failure this module raises.

    Carries the command and captured (already-redacted) output so callers
    building a platform-specific retry chain can inspect why a step failed
    without re-parsing an exception message.
    """

    def __init__(
        self,
        message: str,
        *,
        command: tuple[str, ...],
        returncode: int | None = None,
        stdout: str = "",
        stderr: str = "",
    ) -> None:
        super().__init__(message)
        self.command = command
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class CliTimeoutError(CliError):
    """The child process did not exit within the timeout."""


class CliCommandError(CliError):
    """The child process exited with a non-zero status."""


class CliEmptyOutputError(CliError):
    """Exit code 0 with empty stdout.

    Silent credential expiry looks exactly like "no new posts" — this is
    the failure mode that quietly poisons scoring data if it's not caught
    here. Callers that know a command can legitimately return nothing pass
    allow_empty_output=True explicitly.
    """


@dataclass(frozen=True)
class CliResult:
    command: tuple[str, ...]
    stdout: str
    stderr: str  # already redacted against every credential value passed in
    duration_seconds: float


def _redact(text: str, secrets: dict[str, str]) -> str:
    """Replace any secret value appearing in text with a fixed placeholder.

    Longest values are redacted first so a shorter secret that happens to
    be a substring of a longer one doesn't leave a partial value exposed.
    """
    redacted = text
    for value in sorted((v for v in secrets.values() if v), key=len, reverse=True):
        redacted = redacted.replace(value, "[REDACTED]")
    return redacted


def _assert_no_secrets_in_argv(argv: list[str], secrets: dict[str, str]) -> None:
    """Fail loudly if a credential value leaked into argv instead of env.

    Process argument lists are visible to anything that can list processes
    on the host. Credentials belong in env_overrides only; this is a
    defensive check against a caller mistake, not the primary contract —
    the primary contract is simply "never construct argv with a secret in
    it" in the first place.
    """
    for value in secrets.values():
        if not value:
            continue
        for part in argv:
            if value in part:
                raise ValueError(
                    "credential value found in argv — pass credentials via "
                    "env_overrides, never as a command argument"
                )


def run(
    argv: list[str],
    *,
    env_overrides: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    allow_empty_output: bool = False,
) -> CliResult:
    """Run one upstream CLI invocation under the ingestion subprocess contract.

    - Credentials go in env_overrides and are injected into the child
      process's environment only; the current process's own environment is
      never mutated.
    - stdout and stderr are captured separately. stderr is redacted against
      every value in env_overrides before it is ever returned, logged, or
      raised in an exception message — callers must not parse stderr as
      data, but they may safely log it.
    - Raises CliTimeoutError if the child doesn't exit within `timeout`.
    - Raises CliCommandError on a non-zero exit code.
    - Raises CliEmptyOutputError on exit code 0 with empty stdout, unless
      allow_empty_output=True.
    """
    env_overrides = env_overrides or {}
    _assert_no_secrets_in_argv(argv, env_overrides)
    child_env = {**os.environ, **env_overrides}

    start = time.monotonic()
    try:
        completed = subprocess.run(
            argv,
            env=child_env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        stderr = _redact(exc.stderr or "", env_overrides)
        raise CliTimeoutError(
            f"{argv[0]} timed out after {timeout}s",
            command=tuple(argv),
            stderr=stderr,
        ) from None
    duration = time.monotonic() - start

    stdout = completed.stdout or ""
    stderr = _redact(completed.stderr or "", env_overrides)

    if completed.returncode != 0:
        raise CliCommandError(
            f"{argv[0]} exited {completed.returncode}",
            command=tuple(argv),
            returncode=completed.returncode,
            stdout=stdout,
            stderr=stderr,
        )

    if not stdout.strip() and not allow_empty_output:
        raise CliEmptyOutputError(
            f"{argv[0]} exited 0 with empty stdout — treated as a failure, "
            "never as zero results",
            command=tuple(argv),
            returncode=0,
            stdout=stdout,
            stderr=stderr,
        )

    return CliResult(
        command=tuple(argv),
        stdout=stdout,
        stderr=stderr,
        duration_seconds=duration,
    )


def run_with_retry(
    argv: list[str],
    *,
    env_overrides: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    allow_empty_output: bool = False,
    attempts: int = 2,
    backoff_seconds: float = 2.0,
) -> CliResult:
    """Retry the same command on transient failure, with exponential backoff.

    This covers only the "retry once, same command" step that opens every
    documented retry chain in agent_reach/skill/references/social.md. A
    chain that falls back to a *different* command on repeated failure
    (e.g. Twitter search: retry -> `pipx upgrade twitter-cli` && retry ->
    fall back to `feed`/`user-posts`) is platform-specific behavior that an
    adapter builds by composing multiple run() / run_with_retry() calls in
    the documented order — never improvised, and not something this
    generic helper should encode.
    """
    last_error: CliError | None = None
    for attempt in range(attempts):
        try:
            return run(
                argv,
                env_overrides=env_overrides,
                timeout=timeout,
                allow_empty_output=allow_empty_output,
            )
        except (CliTimeoutError, CliCommandError, CliEmptyOutputError) as exc:
            last_error = exc
            if attempt < attempts - 1:
                time.sleep(backoff_seconds * (2**attempt))
    assert last_error is not None
    raise last_error
