-- Tipster Aggregator schema (Prompt 8 -- ported from this project's earlier
-- Postgres migration history, backend/db/migrations/001-011, to a single
-- Supabase migration since there's no incremental history to preserve on a
-- fresh start). Same tables, same constraints, same reasoning as before --
-- only the delivery mechanism (Supabase-managed Postgres, not a
-- self-run instance) and the number of files changed.
--
-- RLS is left off deliberately: this is a single-user personal app, and the
-- Node backend talks to Supabase with the service-role key from a trusted
-- server context only, never a client-exposed anon key. Enabling RLS here
-- would add policy-authoring overhead with no real access-control benefit
-- at this app's actual shape -- if a client ever talks to Supabase directly
-- with a public key, revisit this.

create extension if not exists pgcrypto;

-- fixtures ------------------------------------------------------------

create table if not exists fixtures (
    id uuid primary key default gen_random_uuid(),
    provider_fixture_id bigint unique not null,
    competition text not null,
    home text not null,
    away text not null,
    kickoff_utc timestamptz not null,
    status text,
    created_at timestamptz not null default now()
);

-- odds_snapshots --------------------------------------------------------
-- Append-only: every poll INSERTs a new row, nothing is ever UPDATEd in
-- place except is_closing_line, set after kickoff. Without the full price
-- history there is no CLV, and CLV is the fast signal this whole method
-- leans on before a strategy has hundreds of settled bets.

create table if not exists odds_snapshots (
    id uuid primary key default gen_random_uuid(),
    fixture_id uuid not null references fixtures (id),
    bookmaker text not null,
    market text not null,
    selection text not null,
    line numeric,
    odds numeric not null check (odds > 1.0),
    captured_at timestamptz not null default now(),
    is_closing_line boolean not null default false
);

create index if not exists idx_odds_snapshots_lookup
    on odds_snapshots (fixture_id, bookmaker, market, selection, captured_at desc);
create index if not exists idx_odds_snapshots_closing_line
    on odds_snapshots (fixture_id) where is_closing_line;

-- Flags the closing line for every fixture that has already kicked off --
-- the latest snapshot captured *before* kickoff, per
-- (fixture, bookmaker, market, selection), not simply "the last snapshot
-- written" (a poll could in principle run late). Only touches fixtures
-- whose kickoff has passed and rows not already flagged, so it's safe to
-- call on every scan without re-scanning settled fixtures. A Postgres
-- function (not a plain query) because the correlated DISTINCT ON UPDATE
-- this needs isn't expressible through the Supabase JS client's query
-- builder -- lib/supabase.js calls this via .rpc().
create or replace function finalize_closing_lines()
returns integer
language sql
as $$
    with latest as (
        select distinct on (os2.fixture_id, os2.bookmaker, os2.market, os2.selection)
            os2.id
        from odds_snapshots os2
        join fixtures f on f.id = os2.fixture_id
        where os2.captured_at < f.kickoff_utc
          and os2.is_closing_line = false
          and f.kickoff_utc < now()
        order by os2.fixture_id, os2.bookmaker, os2.market, os2.selection, os2.captured_at desc
    ),
    updated as (
        update odds_snapshots os
        set is_closing_line = true
        from latest
        where os.id = latest.id
        returning os.id
    )
    select count(*)::integer from updated;
$$;

-- strategies ------------------------------------------------------------
-- What gets scored: competition + market_class + edge_threshold +
-- source_book, replacing a tipster "source" for auto-detected selections.

create table if not exists strategies (
    id uuid primary key default gen_random_uuid(),
    competition text not null,
    market_class text not null,
    edge_threshold numeric not null default 0.02,
    source_book text not null,
    active boolean not null default true,
    first_seen timestamptz not null default now(),
    unique (competition, market_class, edge_threshold, source_book)
);

-- selections --------------------------------------------------------------
-- Shared by every origin. Immutable after insert -- corrections are new
-- rows, not updates. Not trigger-enforced, same convention as
-- odds_snapshots: application code inserts only.

create table if not exists selections (
    id uuid primary key default gen_random_uuid(),
    origin text not null check (origin in ('social', 'auto_odds', 'manual_check')),
    post_id uuid,
    fixture_id uuid references fixtures (id),
    strategy_id uuid references strategies (id),

    sport text not null default 'soccer',
    competition text not null,
    home text not null,
    away text not null,
    kickoff_utc timestamptz not null,

    market text not null,
    pick text not null,
    line numeric,

    claimed_odds numeric check (claimed_odds is null or claimed_odds > 1.0),
    verified_odds numeric check (verified_odds is null or verified_odds > 1.0),
    verified_odds_source text,
    bookmaker text,

    fair_probability numeric check (fair_probability is null or (fair_probability > 0 and fair_probability < 1)),
    fair_odds numeric check (fair_odds is null or fair_odds > 1.0),
    edge numeric,

    confidence_extraction numeric check (confidence_extraction is null or (confidence_extraction >= 0 and confidence_extraction <= 1)),
    extraction_model text,

    created_at timestamptz not null default now()
);

create index if not exists idx_selections_fixture on selections (fixture_id);
create index if not exists idx_selections_strategy on selections (strategy_id);
create index if not exists idx_selections_kickoff on selections (kickoff_utc);

-- manual_checks -----------------------------------------------------------
-- Every check a user makes against the manual price-check screen, logged
-- regardless of whether they actually placed the bet. selection_id is set
-- only when they confirm they did, promoting the check into a scoreable
-- selection.

create table if not exists manual_checks (
    id uuid primary key default gen_random_uuid(),
    fixture_id uuid references fixtures (id),
    market text not null,
    pick text not null,
    line numeric,
    fair_probability numeric not null check (fair_probability > 0 and fair_probability < 1),
    fair_odds numeric not null check (fair_odds > 1.0),
    entered_odds numeric not null check (entered_odds > 1.0),
    entered_bookmaker text not null,
    edge numeric not null,
    stake_fraction numeric,
    checked_at timestamptz not null default now(),
    selection_id uuid references selections (id)
);

create index if not exists idx_manual_checks_checked_at on manual_checks (checked_at desc);

-- settlements -------------------------------------------------------------
-- One row per settled selection. settlement_rule_version lets a rule fix
-- trigger a targeted re-grade, not a full rebuild. payout_fraction (< 1.0
-- only for a quarter-line Asian handicap/totals half win or half loss) is
-- included from the start here since this is a fresh schema, not bolted on
-- as a later migration the way it was in this project's earlier history.

create table if not exists settlements (
    selection_id uuid primary key references selections (id),
    status text not null check (status in ('won', 'lost', 'void', 'push', 'ungradeable')),
    payout_fraction numeric not null default 1.0 check (payout_fraction > 0 and payout_fraction <= 1.0),
    settled_at timestamptz not null default now(),
    result_payload jsonb,
    settlement_rule_version text not null
);

create index if not exists idx_settlements_settled_at on settlements (settled_at desc);

-- Selections whose fixture kicked off more than `cutoff` ago (pass
-- now() - interval '150 minutes' from the caller, matching Task B6's
-- sweep window) with no settlement row yet. An anti-join the Supabase JS
-- client's query builder can't express directly, hence an RPC function
-- like finalize_closing_lines above.
create or replace function find_pending_selections(cutoff timestamptz)
returns table (id uuid, fixture_id uuid, market text, pick text, line numeric)
language sql
as $$
    select sel.id, sel.fixture_id, sel.market, sel.pick, sel.line
    from selections sel
    join fixtures f on f.id = sel.fixture_id
    left join settlements st on st.selection_id = sel.id
    where st.selection_id is null
      and f.kickoff_utc < cutoff;
$$;

-- strategy_scores -----------------------------------------------------------
-- Recomputed (not appended) per (strategy_id, window). "window" is a
-- reserved word in Postgres, hence the double-quoting throughout.

create table if not exists strategy_scores (
    strategy_id uuid not null references strategies (id),
    "window" text not null check ("window" in ('30d', '90d', 'all')),

    n_settled integer not null,
    roi numeric,
    roi_ci_low numeric,
    roi_ci_high numeric,
    hit_rate numeric,
    avg_odds numeric,
    mean_clv numeric,
    pct_positive_clv numeric,
    longest_losing_run integer,

    computed_at timestamptz not null default now(),

    primary key (strategy_id, "window")
);

-- Settled selections for one strategy within a window, each with its
-- sharp-book (Pinnacle) closing line for CLV -- a correlated subquery per
-- row the JS query builder can't express, hence an RPC function.
-- p_window_start = null means "all time" (no cutoff).
create or replace function load_settled_selections_for_strategy(p_strategy_id uuid, p_window_start timestamptz)
returns table (status text, verified_odds numeric, settled_at timestamptz, post_id uuid, payout_fraction numeric, closing_odds numeric)
language sql
as $$
    select
        st.status,
        sel.verified_odds,
        st.settled_at,
        sel.post_id,
        st.payout_fraction,
        (
            select os.odds from odds_snapshots os
            where os.fixture_id = sel.fixture_id
              and os.bookmaker = 'pinnacle'
              and os.market = sel.market
              and os.selection = sel.pick
              and os.is_closing_line = true
            limit 1
        ) as closing_odds
    from selections sel
    join settlements st on st.selection_id = sel.id
    where sel.strategy_id = p_strategy_id
      and (p_window_start is null or st.settled_at >= p_window_start);
$$;

-- ingestion_health ----------------------------------------------------------
-- Every poll of every provider records one row here, always -- success,
-- legitimate emptiness, and failure are three different facts and must
-- never collapse into one.

create table if not exists ingestion_health (
    id uuid primary key default gen_random_uuid(),
    platform text not null,
    status text not null check (status in ('ok', 'empty', 'error')),
    detail text,
    run_at timestamptz not null default now()
);

create index if not exists idx_ingestion_health_platform_run_at
    on ingestion_health (platform, run_at desc);

-- slips ---------------------------------------------------------------------

create table if not exists slips (
    id uuid primary key default gen_random_uuid(),
    band text not null check (band in ('A', 'B', 'C', 'D', 'E')),
    target_min_odds numeric not null,
    target_max_odds numeric not null,
    combined_odds numeric not null check (combined_odds > 1.0),
    legs_json jsonb not null,
    built_at timestamptz not null default now(),
    status text not null default 'pending' check (status in ('pending', 'won', 'lost', 'void')),
    settled_at timestamptz
);

create index if not exists idx_slips_band_built_at on slips (band, built_at desc);

-- audit_calls -----------------------------------------------------------
-- Separate pipeline, never feeds the slip builder. source_id has no FK yet
-- -- the deferred social path's `sources` table doesn't exist in this
-- schema (on hold behind sources.social.enabled).

create table if not exists audit_calls (
    id uuid primary key default gen_random_uuid(),
    source_id uuid not null,
    game text not null,
    claimed_target numeric,
    claimed_outcome text,
    verifiable boolean not null,
    posted_at timestamptz,
    captured_at timestamptz not null default now(),
    notes text
);

create index if not exists idx_audit_calls_source on audit_calls (source_id);
