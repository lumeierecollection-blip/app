-- selections (Task B3/B5/B6) -- shared by every origin (auto-detected
-- odds-market edges, manual price checks, and eventually deferred-path
-- social tips). This is what gets settled and scored; everything
-- upstream of this table (odds_snapshots, manual_checks, and eventually
-- posts) is a candidate, this is a commitment.
--
-- Immutable after insert, regardless of origin, per docs/ARCHITECTURE.md
-- Data model "Non-negotiable constraints" -- corrections are new rows,
-- not UPDATEs. Not trigger-enforced (same convention as odds_snapshots:
-- application code inserts only), documented here as the load-bearing
-- rule it is.
--
-- post_id has no FK constraint: the deferred social path's `posts` table
-- doesn't exist yet (on hold behind sources.social.enabled). Same
-- forward-reference pattern already used for manual_checks.selection_id
-- in 004_manual_checks.sql -- add the FK when `posts` lands.

CREATE TABLE IF NOT EXISTS selections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    origin TEXT NOT NULL CHECK (origin IN ('social', 'auto_odds', 'manual_check')),
    post_id UUID,
    fixture_id UUID REFERENCES fixtures (id),
    strategy_id UUID REFERENCES strategies (id),

    sport TEXT NOT NULL DEFAULT 'soccer',
    competition TEXT NOT NULL,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    kickoff_utc TIMESTAMPTZ NOT NULL,

    market TEXT NOT NULL,
    pick TEXT NOT NULL,
    line NUMERIC,

    claimed_odds NUMERIC CHECK (claimed_odds IS NULL OR claimed_odds > 1.0),
    verified_odds NUMERIC CHECK (verified_odds IS NULL OR verified_odds > 1.0),
    verified_odds_source TEXT,
    bookmaker TEXT,

    fair_probability NUMERIC CHECK (fair_probability IS NULL OR (fair_probability > 0 AND fair_probability < 1)),
    fair_odds NUMERIC CHECK (fair_odds IS NULL OR fair_odds > 1.0),
    edge NUMERIC,

    confidence_extraction NUMERIC CHECK (confidence_extraction IS NULL OR (confidence_extraction >= 0 AND confidence_extraction <= 1)),
    extraction_model TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_selections_fixture ON selections (fixture_id);
CREATE INDEX IF NOT EXISTS idx_selections_strategy ON selections (strategy_id);
CREATE INDEX IF NOT EXISTS idx_selections_kickoff ON selections (kickoff_utc);

-- manual_checks.selection_id can now reference a real table (see
-- 004_manual_checks.sql's comment -- this is that later migration).
ALTER TABLE manual_checks
    ADD CONSTRAINT fk_manual_checks_selection FOREIGN KEY (selection_id) REFERENCES selections (id);
