-- strategies (Amendment B5) -- what gets scored in the odds-market path,
-- replacing a tipster "source". A strategy is a configuration, not an
-- account: competition + market_class + edge_threshold + source_book.
-- Schema only in this migration -- Task B2 doesn't populate or read this
-- table yet; it's created now because Task B3 (edge detection) and B5
-- (scoring) both need it to exist, and because the amendment's own task
-- list groups it with this migration set.

CREATE TABLE IF NOT EXISTS strategies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    competition TEXT NOT NULL,
    market_class TEXT NOT NULL,
    edge_threshold NUMERIC NOT NULL DEFAULT 0.02,
    source_book TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (competition, market_class, edge_threshold, source_book)
);
