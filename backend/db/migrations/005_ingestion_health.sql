-- ingestion_health (Task B2, generalizing the pattern originally
-- specified for Agent Reach's doctor gate in the deferred social path --
-- see docs/ARCHITECTURE.md "Ingestion architecture" for both). Every
-- poll of every provider records one row here, always -- success,
-- legitimate emptiness, and failure are three different facts and must
-- never collapse into one:
--
--   'ok'    -- call succeeded, returned data
--   'empty' -- call succeeded, genuinely nothing to report right now
--             (e.g. no fixtures for a competition today)
--   'error' -- call failed outright: timeout, non-2xx, unparseable body,
--             or a rate/quota limit. detail carries the reason.
--
-- Quota exhaustion is this pipeline's version of cookie expiry in the
-- deferred social path: it fails the same way, silently, and looks
-- exactly like "empty" unless it's explicitly recorded as 'error' with
-- its own reason. That distinction is the entire point of this table --
-- collapsing 'error' into 'empty' anywhere in application code defeats
-- it.

CREATE TABLE IF NOT EXISTS ingestion_health (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'error')),
    detail TEXT,
    run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_health_platform_run_at
    ON ingestion_health (platform, run_at DESC);
