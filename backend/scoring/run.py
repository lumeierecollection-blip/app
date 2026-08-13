"""Task B5 entrypoint: recompute strategy_scores for every active
strategy, across all three windows. Meant to run on the same recurring
cron cadence as settlement (Task B6) -- after new selections settle,
scores need to reflect them.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import psycopg

from .repository import WINDOW_DAYS, load_settled_selections, upsert_strategy_score
from .strategy_scoring import score_strategy


def score_all_strategies(conn: psycopg.Connection, *, now: datetime | None = None) -> int:
    """Recompute and store strategy_scores for every active strategy and
    window. Returns the number of (strategy, window) scores written."""
    now = now or datetime.now(timezone.utc)
    strategy_ids = [str(row[0]) for row in conn.execute("SELECT id FROM strategies WHERE active = true")]

    written = 0
    for strategy_id in strategy_ids:
        for window in WINDOW_DAYS:
            selections = load_settled_selections(conn, strategy_id=strategy_id, window=window, now=now)
            result = score_strategy(selections, now=now)
            upsert_strategy_score(conn, strategy_id=strategy_id, window=window, result=result, computed_at=now)
            written += 1
    return written


def main() -> int:
    database_url = os.environ["DATABASE_URL"]
    with psycopg.connect(database_url) as conn:
        written = score_all_strategies(conn)
        conn.commit()
        print(f"Wrote {written} strategy score(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
