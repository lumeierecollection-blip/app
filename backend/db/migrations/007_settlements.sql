-- settlements (Task B6) -- one row per settled selection. Settlement
-- rules are versioned pure functions (backend/settlement/), and
-- settlement_rule_version is stored per row so a rule fix triggers a
-- targeted re-grade of exactly the selections it affects, not a full
-- rebuild (docs/ARCHITECTURE.md § "Settlement").
--
-- One selection settles exactly once -- selection_id is the primary key,
-- not a separate id, since there is no legitimate reason for more than
-- one settlement row per selection (a correction re-settles the same
-- row via UPDATE, deliberately breaking the "immutable, insert-only"
-- convention used elsewhere in this schema, because a settlement is a
-- verdict about something external that can itself need correcting, not
-- an append-only observation like an odds quote).

CREATE TABLE IF NOT EXISTS settlements (
    selection_id UUID PRIMARY KEY REFERENCES selections (id),
    status TEXT NOT NULL CHECK (status IN ('won', 'lost', 'void', 'push', 'ungradeable')),
    settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    result_payload JSONB,
    settlement_rule_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settlements_settled_at ON settlements (settled_at DESC);
