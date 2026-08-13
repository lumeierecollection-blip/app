-- strategy_scores (Task B5, docs/SCORING.md Amendment B5) -- computed
-- reliability scores per strategy per rolling window. Same shape as the
-- deferred path's source_scores would be, plus mean_clv /
-- pct_positive_clv, since CLV is the headline metric shown above ROI on
-- every screen (Amendment B5 -- ROI over 50 bets is mostly noise, CLV
-- over 50 bets is real signal).
--
-- Recomputed (not appended) per (strategy_id, "window") -- a score is a
-- point-in-time summary, not an observation to preserve history for; the
-- underlying settlements it's computed from are what stays immutable.
--
-- "window" is a reserved word in Postgres (used by window functions), so
-- every reference to the column needs double-quoting -- this doesn't
-- change the column's real name, which stays exactly as
-- docs/ARCHITECTURE.md's Data model sketch names it.

CREATE TABLE IF NOT EXISTS strategy_scores (
    strategy_id UUID NOT NULL REFERENCES strategies (id),
    "window" TEXT NOT NULL CHECK ("window" IN ('30d', '90d', 'all')),

    n_settled INTEGER NOT NULL,
    roi NUMERIC,
    roi_ci_low NUMERIC,
    roi_ci_high NUMERIC,
    hit_rate NUMERIC,
    avg_odds NUMERIC,
    mean_clv NUMERIC,
    pct_positive_clv NUMERIC,
    longest_losing_run INTEGER,

    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (strategy_id, "window")
);
