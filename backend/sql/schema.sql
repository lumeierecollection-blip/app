-- Amendment E schema (Prompt 9): the no-API path. One SQLite file on the
-- cloud host's disk, replacing the retired Supabase/Postgres schema for the
-- odds-market path. Same semantics as the old Postgres migrations where the
-- concept carries over (captured_at set by us, immutable selections, the
-- 50-sample gate, CLV) -- only the delivery mechanism changed.
--
-- Timestamps are ISO-8601 UTC strings with 'Z' (e.g. 2026-08-14T19:00:00.000Z),
-- written by application code, never parsed from the platform for the
-- fields that matter. SQLite's own datetime('now') is used only as a
-- defensive default where the value is never timezone-sensitive.

-- sources ----------------------------------------------------------------
-- The things that get scored. platform is 'telegram' on this path; the
-- column exists so the deferred Agent Reach platforms (twitter/reddit)
-- can join later without a migration.

create table if not exists sources (
    id integer primary key autoincrement,
    platform text not null default 'telegram',
    handle text not null unique,
    display_name text,
    active integer not null default 1,
    first_seen text not null
);

-- posts ------------------------------------------------------------------
-- One row per Telegram message we ingest. captured_at is set by US at
-- ingest time, never parsed from the platform. platform_post_id is the
-- Telegram message id -- the uniqueness that makes re-sync idempotent.

create table if not exists posts (
    id integer primary key autoincrement,
    source_id integer not null references sources (id),
    platform_post_id text not null unique,
    captured_at text not null,
    posted_at text,
    raw_text text,
    media integer not null default 0,
    content_hash text,
    edited_flag integer not null default 0,
    created_at text not null
);

create index if not exists idx_posts_source on posts (source_id);
create index if not exists idx_posts_captured on posts (captured_at);

-- selections -------------------------------------------------------------
-- Immutable after insert -- corrections are new rows, never updates.
-- gradeable is computed at insert time from the §7 rule: a selection is
-- gradeable only if captured_at < kickoff_utc. oddsUsed (the scoring
-- formula's input) = verified_odds when present, else claimed_odds.
-- provider_event_id is the ESPN event id the selection was parsed from --
-- what settlement uses to match a finished result without name guessing.
-- closing_odds (the reference book's closing line for the same market/pick,
-- used for CLV) lives on the settlements row, not here: it is only known
-- post-match, and selections are immutable.

create table if not exists selections (
    id integer primary key autoincrement,
    post_id integer not null references posts (id),
    source_id integer not null references sources (id),
    provider_event_id text,
    competition text,
    home text not null,
    away text not null,
    kickoff_utc text not null,
    market text not null,
    pick text not null,
    line real,
    claimed_odds real check (claimed_odds is null or claimed_odds > 1.0),
    verified_odds real check (verified_odds is null or verified_odds > 1.0),
    verified_odds_source text,
    gradeable integer not null default 1,
    created_at text not null
);

create index if not exists idx_selections_source on selections (source_id);
create index if not exists idx_selections_kickoff on selections (kickoff_utc);

-- settlements ------------------------------------------------------------
-- One row per settled selection. status/payout_fraction/rule_version match
-- lib/settlement.js exactly so a rule fix can re-grade a target, not a
-- rebuild. result_payload is the normalized result contract
-- ({matchStatus, goalsHome, goalsAway}). closing_odds is the reference
-- book's closing line for the same market/pick, read from the finished
-- match's odds block at settlement time -- it feeds CLV and is written
-- here so selections stay immutable.

create table if not exists settlements (
    selection_id integer primary key references selections (id),
    status text not null check (status in ('won', 'lost', 'void', 'push', 'ungradeable')),
    payout_fraction real not null default 1.0 check (payout_fraction > 0 and payout_fraction <= 1.0),
    settled_at text not null,
    result_payload text,
    settlement_rule_version text not null,
    closing_odds real
);

create index if not exists idx_settlements_settled_at on settlements (settled_at);

-- source_scores ----------------------------------------------------------
-- Recomputed per (source_id, window). window is the same 30d/90d/all set
-- as the old path. rated is derived (n_settled >= 50), stored implicitly
-- through n_settled -- the notification gate reads this table. disqualified
-- carries the §7 source-level disqualifiers (post-kickoff capture rate,
-- claimed-odds inflation, posted-after-result); the notification gate
-- requires rated AND not disqualified.

create table if not exists source_scores (
    source_id integer not null references sources (id),
    "window" text not null check ("window" in ('30d', '90d', 'all')),
    n_settled integer not null,
    roi real,
    roi_ci_low real,
    roi_ci_high real,
    hit_rate real,
    avg_odds real,
    mean_clv real,
    pct_positive_clv real,
    longest_losing_run integer,
    disqualified integer not null default 0,
    disqualification_reasons text,
    computed_at text not null,
    primary key (source_id, "window")
);

-- devices -----------------------------------------------------------------
-- FCM registration tokens sent by the app via POST /api/register-device.
-- token is unique; re-registration (reinstall, new login) just upserts the
-- last_seen timestamp. app_install_id lets a future session reconcile
-- stale tokens (uninstall detection) without guessing from the token.

create table if not exists devices (
    id integer primary key autoincrement,
    token text not null unique,
    app_install_id text,
    platform text not null default 'android',
    created_at text not null,
    last_seen_at text not null
);

-- notifications ----------------------------------------------------------
-- Audit trail of every push decision: queued -> sent (or failed). A rated
-- source's new post is queued here by the scan, sent by the notify step,
-- and the FCM message id stored so a later session can reconcile against
-- Firebase's delivery reports.

create table if not exists notifications (
    id integer primary key autoincrement,
    source_id integer not null references sources (id),
    post_id integer not null references posts (id),
    fcm_message_id text,
    status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
    sent_at text,
    created_at text not null
);

create index if not exists idx_notifications_status on notifications (status);
create unique index if not exists idx_notifications_source_post on notifications (source_id, post_id);

-- ingestion_health --------------------------------------------------------
-- Every fetch of every data source records one row, always -- success,
-- legitimate emptiness, and failure are three different facts and must
-- never collapse into one. Same rule as the old path's ingestion_health.

create table if not exists ingestion_health (
    id integer primary key autoincrement,
    platform text not null,
    status text not null check (status in ('ok', 'empty', 'error')),
    detail text,
    run_at text not null
);

create index if not exists idx_ingestion_health_platform_run_at on ingestion_health (platform, run_at desc);

-- app_state ----------------------------------------------------------------
-- Key/value scratch: the refreshed Telegram StringSession is written here
-- after every auth/save so a restart re-hydrates from the newest session
-- (DB wins over the env-var copy at boot). Lost only when the whole DB
-- file is lost on a redeploy -- that failure is reported loudly by
-- /api/status, never as silent "no posts".

create table if not exists app_state (
    key text primary key,
    value text not null
);
