from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from ingestion.odds.poller import poll_interval_for, should_poll_now

KICKOFF = datetime(2026, 8, 21, 19, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "time_to_kickoff,expected_interval",
    [
        (timedelta(days=3), timedelta(hours=6)),
        (timedelta(hours=25), timedelta(hours=6)),
        (timedelta(hours=12), timedelta(hours=2)),
        (timedelta(hours=3), timedelta(minutes=30)),
        (timedelta(hours=1, minutes=59), timedelta(minutes=15)),
        (timedelta(minutes=1), timedelta(minutes=15)),
    ],
)
def test_poll_interval_widens_further_from_kickoff(time_to_kickoff, expected_interval):
    assert poll_interval_for(time_to_kickoff) == expected_interval


def test_should_poll_now_true_on_first_ever_poll_discovery():
    assert should_poll_now(kickoff_utc=KICKOFF, last_polled_at=None, now=KICKOFF - timedelta(days=5))


def test_should_poll_now_false_once_kickoff_has_passed():
    assert not should_poll_now(
        kickoff_utc=KICKOFF,
        last_polled_at=KICKOFF - timedelta(hours=1),
        now=KICKOFF + timedelta(minutes=1),
    )


def test_should_poll_now_false_when_interval_has_not_elapsed():
    now = KICKOFF - timedelta(hours=1, minutes=30)  # inside the final window (15 min interval)
    assert not should_poll_now(kickoff_utc=KICKOFF, last_polled_at=now - timedelta(minutes=5), now=now)


def test_should_poll_now_true_once_interval_has_elapsed():
    now = KICKOFF - timedelta(hours=1, minutes=30)
    assert should_poll_now(kickoff_utc=KICKOFF, last_polled_at=now - timedelta(minutes=16), now=now)


def test_should_poll_now_true_exactly_at_the_interval_boundary():
    now = KICKOFF - timedelta(hours=1)
    assert should_poll_now(kickoff_utc=KICKOFF, last_polled_at=now - timedelta(minutes=15), now=now)


def test_final_window_boundary_is_15_minutes_not_30():
    """Right at the 2h mark, the interval must already be 15 min, not the
    wider 30 min tier -- the brief's final-2-hours requirement starts
    exactly there, not one poll later."""
    assert poll_interval_for(timedelta(hours=2)) == timedelta(minutes=15)
    assert poll_interval_for(timedelta(hours=2, minutes=1)) == timedelta(minutes=30)
