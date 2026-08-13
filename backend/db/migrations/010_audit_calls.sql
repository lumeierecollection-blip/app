-- audit_calls (brief §9, docs/ARCHITECTURE.md § "Audit module (Aviator /
-- virtuals)") -- separate pipeline, never feeds the slip builder. Records
-- claimed "signal" calls so they can be checked against chance, not
-- rendered as actionable predictions.
--
-- source_id has no FK constraint yet: the deferred social path's
-- `sources` table doesn't exist in this schema (on hold behind
-- sources.social.enabled). Same forward-reference pattern as
-- selections.post_id in 006_selections.sql -- add the FK when `sources`
-- lands.

CREATE TABLE IF NOT EXISTS audit_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL,
    game TEXT NOT NULL,
    claimed_target NUMERIC,
    claimed_outcome TEXT,
    verifiable BOOLEAN NOT NULL,
    posted_at TIMESTAMPTZ,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_calls_source ON audit_calls (source_id);
