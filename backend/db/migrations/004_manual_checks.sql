-- manual_checks (Task B4) -- schema only in this migration. Every check
-- a user makes against the manual price-check screen gets logged here
-- regardless of whether they actually placed the bet; selection_id is
-- set only when they confirm they did, promoting the check into a
-- scoreable selection.
--
-- selection_id has no foreign-key constraint yet: the `selections` table
-- (shared by both the odds-market and deferred social paths, per
-- docs/ARCHITECTURE.md's Data model) doesn't exist until a later
-- migration adds it alongside settlement/scoring. Add the FK constraint
-- in that migration -- do not silently skip it once the referenced table
-- exists.

CREATE TABLE IF NOT EXISTS manual_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fixture_id UUID REFERENCES fixtures (id),
    market TEXT NOT NULL,
    pick TEXT NOT NULL,
    line NUMERIC,
    fair_probability NUMERIC NOT NULL CHECK (fair_probability > 0 AND fair_probability < 1),
    fair_odds NUMERIC NOT NULL CHECK (fair_odds > 1.0),
    entered_odds NUMERIC NOT NULL CHECK (entered_odds > 1.0),
    entered_bookmaker TEXT NOT NULL,
    edge NUMERIC NOT NULL,
    stake_fraction NUMERIC,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    selection_id UUID
);

CREATE INDEX IF NOT EXISTS idx_manual_checks_checked_at ON manual_checks (checked_at DESC);
