-- settlements.payout_fraction (Task B6) -- extends the schema sketched
-- in docs/ARCHITECTURE.md's Data model section by one column, and it's
-- necessary, not decorative: that same doc requires settlement rules to
-- correctly handle "Asian handicap quarter-lines (half win / half push)"
-- as a mandatory tested case, and a bare won/lost/void/push/ungradeable
-- status cannot represent "half the stake won, half pushed" without
-- losing information that directly changes a strategy's real ROI.
--
-- Defaults to 1.0 (full stake) for every settlement where the concept
-- doesn't apply -- 1X2, totals on a half line, BTTS, and non-quarter AH
-- lines are always exactly 1.0. Only quarter-line Asian handicap and
-- quarter-line totals settlements ever produce 0.5.

ALTER TABLE settlements
    ADD COLUMN payout_fraction NUMERIC NOT NULL DEFAULT 1.0
        CHECK (payout_fraction > 0 AND payout_fraction <= 1.0);
