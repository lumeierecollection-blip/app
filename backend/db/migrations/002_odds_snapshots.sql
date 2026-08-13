-- odds_snapshots (Amendment B, Task B2) -- the single most load-bearing
-- table in the odds-market path. Append-only: every poll INSERTs a new
-- row, nothing is ever UPDATEd in place. Without the full price history
-- there is no CLV, and CLV is the fast signal this whole method leans on
-- before a strategy has hundreds of settled bets (see docs/SCORING.md,
-- Amendment B5 addendum).
--
-- is_closing_line is NOT set at insert time -- it can't be, since we
-- don't know a snapshot is the last one before kickoff until kickoff has
-- actually passed. A separate finalization step (fixture_matching /
-- poller) flags it after the fact, exactly once per
-- (fixture_id, bookmaker, market, selection, line).

CREATE TABLE IF NOT EXISTS odds_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fixture_id UUID NOT NULL REFERENCES fixtures (id),
    bookmaker TEXT NOT NULL,
    market TEXT NOT NULL,
    selection TEXT NOT NULL,
    line NUMERIC,
    odds NUMERIC NOT NULL CHECK (odds > 1.0),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_closing_line BOOLEAN NOT NULL DEFAULT false
);

-- Append-only in practice, not just in application code: nothing about
-- this table's primary key or shape allows an UPDATE to target "the same
-- quote" -- every insert gets a fresh id. This index is what makes the
-- common read patterns (latest quote per market, full history for a
-- fixture) fast; it is not a substitute for the append-only discipline.
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_lookup
    ON odds_snapshots (fixture_id, bookmaker, market, selection, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_odds_snapshots_closing_line
    ON odds_snapshots (fixture_id) WHERE is_closing_line;
