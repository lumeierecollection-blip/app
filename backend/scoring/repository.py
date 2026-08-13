"""Postgres reads/writes for Task B5 strategy scoring: pull settled
selections for a strategy within a window, look up each one's closing
line for CLV, and upsert the result into `strategy_scores`.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import psycopg

from .strategy_scoring import SettledSelection, StrategyScoreResult

WINDOW_DAYS = {"30d": 30, "90d": 90, "all": None}


def load_settled_selections(
    conn: psycopg.Connection, *, strategy_id: str, window: str, now: datetime
) -> list[SettledSelection]:
    if window not in WINDOW_DAYS:
        raise ValueError(f"unknown window {window!r}, must be one of {list(WINDOW_DAYS)}")

    days = WINDOW_DAYS[window]
    params: list = [strategy_id]
    cutoff_clause = ""
    if days is not None:
        cutoff_clause = "AND st.settled_at >= %s"
        params.append(now - timedelta(days=days))

    rows = conn.execute(
        f"""
        SELECT
            st.status,
            sel.verified_odds,
            st.settled_at,
            sel.post_id,
            st.payout_fraction,
            (
                SELECT os.odds FROM odds_snapshots os
                WHERE os.fixture_id = sel.fixture_id
                  AND os.bookmaker = 'pinnacle'
                  AND os.market = sel.market
                  AND os.selection = sel.pick
                  AND os.is_closing_line = true
                LIMIT 1
            ) AS closing_odds
        FROM selections sel
        JOIN settlements st ON st.selection_id = sel.id
        WHERE sel.strategy_id = %s
        {cutoff_clause}
        """,
        params,
    ).fetchall()

    return [
        SettledSelection(
            status=row[0],
            odds_used=float(row[1]) if row[1] is not None else None,
            settled_at=row[2],
            post_id=str(row[3]) if row[3] is not None else None,
            payout_fraction=float(row[4]),
            closing_odds=float(row[5]) if row[5] is not None else None,
        )
        for row in rows
    ]


def upsert_strategy_score(
    conn: psycopg.Connection, *, strategy_id: str, window: str, result: StrategyScoreResult, computed_at: datetime
) -> None:
    conn.execute(
        """
        INSERT INTO strategy_scores (
            strategy_id, "window", n_settled, roi, roi_ci_low, roi_ci_high,
            hit_rate, avg_odds, mean_clv, pct_positive_clv, longest_losing_run, computed_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (strategy_id, "window") DO UPDATE SET
            n_settled = EXCLUDED.n_settled,
            roi = EXCLUDED.roi,
            roi_ci_low = EXCLUDED.roi_ci_low,
            roi_ci_high = EXCLUDED.roi_ci_high,
            hit_rate = EXCLUDED.hit_rate,
            avg_odds = EXCLUDED.avg_odds,
            mean_clv = EXCLUDED.mean_clv,
            pct_positive_clv = EXCLUDED.pct_positive_clv,
            longest_losing_run = EXCLUDED.longest_losing_run,
            computed_at = EXCLUDED.computed_at
        """,
        (
            strategy_id,
            window,
            result.n_settled,
            result.roi,
            result.roi_ci_low,
            result.roi_ci_high,
            result.hit_rate,
            result.avg_odds,
            result.mean_clv,
            result.pct_positive_clv,
            result.longest_losing_run,
            computed_at,
        ),
    )
