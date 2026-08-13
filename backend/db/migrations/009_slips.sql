-- slips (brief §8, docs/ARCHITECTURE.md § "Slip builder") -- one row per
-- built accumulator. legs_json records which selection each leg came
-- from and that selection's/strategy's score at build time, so a slip's
-- displayed rationale never silently drifts as later scores change.

CREATE TABLE IF NOT EXISTS slips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    band TEXT NOT NULL CHECK (band IN ('A', 'B', 'C', 'D', 'E')),
    target_min_odds NUMERIC NOT NULL,
    target_max_odds NUMERIC NOT NULL,
    combined_odds NUMERIC NOT NULL CHECK (combined_odds > 1.0),
    legs_json JSONB NOT NULL,
    built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'void')),
    settled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_slips_band_built_at ON slips (band, built_at DESC);
