-- Canonical fixture table (Amendment B, Task B2).
--
-- One row per real-world match, regardless of which provider(s) reported
-- it. provider_fixture_id is API-Football's own ID for this fixture --
-- the anchor identity; OddsPapi's fixtureId is a *different* number for
-- the same match and is resolved against this row via fixture matching
-- (see backend/ingestion/odds/fixture_matching.py), not stored as a
-- second primary key.

CREATE TABLE IF NOT EXISTS fixtures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_fixture_id BIGINT NOT NULL,
    competition TEXT NOT NULL,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    kickoff_utc TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'live', 'finished', 'postponed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (provider_fixture_id)
);

CREATE INDEX IF NOT EXISTS idx_fixtures_kickoff_utc ON fixtures (kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_fixtures_status ON fixtures (status);
