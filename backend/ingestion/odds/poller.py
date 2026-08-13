"""Poll-schedule logic (Amendment B2): discovery, then widening
intervals, then every 15 minutes in the final 2 hours before kickoff.
Pure functions — no I/O — so the schedule is testable without a live
call or a database.

The brief specifies "discovery -> widening intervals -> 15 min in the
final 2 hours" but not the intermediate tier boundaries. The values below
are this project's own design choice, not read off an external spec:
"""

from __future__ import annotations

from datetime import timedelta

FINAL_WINDOW = timedelta(hours=2)
FINAL_WINDOW_INTERVAL = timedelta(minutes=15)

# (time-to-kickoff lower bound, poll interval while above that bound),
# ordered widest-to-narrowest. The first tier whose lower bound is
# exceeded by the current time-to-kickoff wins.
_WIDENING_TIERS: list[tuple[timedelta, timedelta]] = [
    (timedelta(hours=24), timedelta(hours=6)),
    (timedelta(hours=6), timedelta(hours=2)),
    (FINAL_WINDOW, timedelta(minutes=30)),
]


def poll_interval_for(time_to_kickoff: timedelta) -> timedelta:
    """How often to poll, given how long until kickoff.

    A non-positive time_to_kickoff (kickoff has passed) still returns a
    concrete interval rather than raising — callers use should_poll_now
    to decide whether to stop polling at all, this function only answers
    "how often," not "whether."
    """
    if time_to_kickoff <= FINAL_WINDOW:
        return FINAL_WINDOW_INTERVAL
    for lower_bound, interval in _WIDENING_TIERS:
        if time_to_kickoff > lower_bound:
            return interval
    return FINAL_WINDOW_INTERVAL


def should_poll_now(*, kickoff_utc, last_polled_at, now) -> bool:
    """Whether a fixture is due for another odds poll right now.

    - Never polls once kickoff has passed — the closing line is whatever
      was captured before that point; polling after doesn't add signal
      and just burns request budget.
    - Always polls immediately the first time (last_polled_at is None) —
      this is "discovery."
    - Otherwise polls once the elapsed time since the last poll reaches
      the interval for the current time-to-kickoff.
    """
    if now >= kickoff_utc:
        return False
    if last_polled_at is None:
        return True
    interval = poll_interval_for(kickoff_utc - now)
    return (now - last_polled_at) >= interval
