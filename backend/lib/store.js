/**
 * Amendment E -- the SQLite store (Task E1). One file on the cloud host's
 * disk, better-sqlite3, schema in sql/schema.sql. All timestamps are
 * ISO-8601 UTC strings ('Z') written by application code.
 *
 * Everything here is thin, synchronous data access -- no business rules
 * beyond the ones that belong to persistence (immutability of selections,
 * the captured_at < kickoff_utc gradeable flag, dedupe on platform_post_id).
 * The math lives in scoring.js / settlement.js, which this module's
 * settledSelectionsForSource() feeds in the exact shape scoreStrategy()
 * expects.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'sql', 'schema.sql'), 'utf8');

export const HEALTH_STATUSES = ['ok', 'empty', 'error'];
export const SCORE_WINDOWS = ['30d', '90d', 'all'];

export class Store {
  /** @param {string} path database file path (':memory:' for tests) */
  constructor(path = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tipster.db')) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    this._upsertSource = this.db.prepare(`
      insert into sources (platform, handle, display_name, active, first_seen)
      values (@platform, @handle, @displayName, @active, @firstSeen)
      on conflict (handle) do update set
        display_name = coalesce(excluded.display_name, sources.display_name),
        active = excluded.active
      returning id
    `);
    this._getSourceByHandle = this.db.prepare('select * from sources where handle = ?');
    this._listSources = this.db.prepare('select * from sources order by handle');

    this._insertPost = this.db.prepare(`
      insert into posts (source_id, platform_post_id, captured_at, posted_at, raw_text, media, content_hash, edited_flag, created_at)
      values (@sourceId, @platformPostId, @capturedAt, @postedAt, @rawText, @media, @contentHash, @editedFlag, @createdAt)
      on conflict (platform_post_id) do nothing
      returning id
    `);
    this._getPostByPlatformId = this.db.prepare('select * from posts where platform_post_id = ?');
    this._listPosts = this.db.prepare(`
      select p.*, s.handle, s.display_name as source_display_name
      from posts p join sources s on s.id = p.source_id
      order by p.captured_at desc, p.id desc
      limit ?
    `);

    this._insertSelection = this.db.prepare(`
      insert into selections
        (post_id, source_id, competition, home, away, kickoff_utc, market, pick, line,
         claimed_odds, verified_odds, verified_odds_source, closing_odds, gradeable, created_at)
      values
        (@postId, @sourceId, @competition, @home, @away, @kickoffUtc, @market, @pick, @line,
         @claimedOdds, @verifiedOdds, @verifiedOddsSource, @closingOdds, @gradeable, @createdAt)
    `);
    this._listSelections = this.db.prepare(`
      select * from selections where source_id = ? order by created_at desc
    `);

    this._upsertSettlement = this.db.prepare(`
      insert into settlements (selection_id, status, payout_fraction, settled_at, result_payload, settlement_rule_version)
      values (@selectionId, @status, @payoutFraction, @settledAt, @resultPayload, @ruleVersion)
      on conflict (selection_id) do update set
        status = excluded.status,
        payout_fraction = excluded.payout_fraction,
        settled_at = excluded.settled_at,
        result_payload = excluded.result_payload,
        settlement_rule_version = excluded.settlement_rule_version
    `);

    this._settledSelectionsForSource = this.db.prepare(`
      select
        st.status,
        st.payout_fraction as payoutFraction,
        st.settled_at as settledAt,
        sel.post_id as postId,
        sel.closing_odds as closingOdds,
        coalesce(sel.verified_odds, sel.claimed_odds) as oddsUsed
      from selections sel
      join settlements st on st.selection_id = sel.id
      where sel.source_id = @sourceId
        and sel.gradeable = 1
        and (@windowStart is null or st.settled_at >= @windowStart)
      order by st.settled_at
    `);

    this._upsertSourceScore = this.db.prepare(`
      insert into source_scores
        (source_id, "window", n_settled, roi, roi_ci_low, roi_ci_high, hit_rate, avg_odds,
         mean_clv, pct_positive_clv, longest_losing_run, computed_at)
      values
        (@sourceId, @window, @nSettled, @roi, @roiCiLow, @roiCiHigh, @hitRate, @avgOdds,
         @meanClv, @pctPositiveClv, @longestLosingRun, @computedAt)
      on conflict (source_id, "window") do update set
        n_settled = excluded.n_settled,
        roi = excluded.roi,
        roi_ci_low = excluded.roi_ci_low,
        roi_ci_high = excluded.roi_ci_high,
        hit_rate = excluded.hit_rate,
        avg_odds = excluded.avg_odds,
        mean_clv = excluded.mean_clv,
        pct_positive_clv = excluded.pct_positive_clv,
        longest_losing_run = excluded.longest_losing_run,
        computed_at = excluded.computed_at
    `);
    this._latestAllWindowScore = this.db.prepare(`
      select * from source_scores where source_id = ? and "window" = 'all' order by computed_at desc limit 1
    `);

    this._insertNotification = this.db.prepare(`
      insert into notifications (source_id, post_id, status, created_at)
      values (@sourceId, @postId, 'queued', @createdAt)
      on conflict do nothing
    `);
    this._pendingNotifications = this.db.prepare(`
      select n.*, s.handle, s.display_name as source_display_name, p.raw_text, p.platform_post_id
      from notifications n
      join sources s on s.id = n.source_id
      join posts p on p.id = n.post_id
      where n.status = 'queued'
      order by n.created_at asc
      limit ?
    `);
    this._markNotificationSent = this.db.prepare(`
      update notifications set status = 'sent', fcm_message_id = @fcmMessageId, sent_at = @sentAt where id = @id
    `);
    this._markNotificationFailed = this.db.prepare(`
      update notifications set status = 'failed', sent_at = @sentAt where id = @id
    `);

    this._recordHealth = this.db.prepare(`
      insert into ingestion_health (platform, status, detail, run_at) values (@platform, @status, @detail, @runAt)
    `);
    this._listHealth = this.db.prepare(`
      select * from ingestion_health where platform = @platform order by run_at desc limit @limit
    `);

    this._getState = this.db.prepare('select value from app_state where key = ?');
    this._setState = this.db.prepare(`
      insert into app_state (key, value) values (@key, @value)
      on conflict (key) do update set value = excluded.value
    `);
  }

  /** Timestamp helper: ISO-8601 UTC with 'Z', matching the codebase's
   * `new Date().toISOString()` everywhere scoring compares times. */
  static ts(d = new Date()) {
    return d.toISOString();
  }

  // sources --------------------------------------------------------------

  /** Insert a source or update display_name/active if the handle exists.
   * @returns {{id: number, created: boolean}} */
  upsertSource({ platform = 'telegram', handle, displayName = null, active = true, now = new Date() }) {
    if (!handle) throw new Error('handle is required');
    const existing = this._getSourceByHandle.get(handle);
    const row = this._upsertSource.get({
      platform,
      handle,
      displayName: displayName ?? null,
      active: active ? 1 : 0,
      firstSeen: Store.ts(now),
    });
    return { id: row.id, created: !existing };
  }

  listSources() {
    return this._listSources.all().map((s) => ({ ...s, active: !!s.active }));
  }

  getSourceByHandle(handle) {
    const s = this._getSourceByHandle.get(handle);
    return s ? { ...s, active: !!s.active } : null;
  }

  // posts -----------------------------------------------------------------

  /** Idempotent: a second insert for the same platform_post_id returns the
   * existing row with created=false (that is what makes Telegram re-sync
   * safe after a DB loss). */
  insertPost({ sourceId, platformPostId, capturedAt, postedAt = null, rawText = null, media = false, contentHash = null, editedFlag = false, now = new Date() }) {
    if (!sourceId || !platformPostId || !capturedAt) {
      throw new Error('sourceId, platformPostId, and capturedAt are required');
    }
    const row = this._insertPost.get({
      sourceId,
      platformPostId: String(platformPostId),
      capturedAt,
      postedAt: postedAt ?? null,
      rawText: rawText ?? null,
      media: media ? 1 : 0,
      contentHash: contentHash ?? null,
      editedFlag: editedFlag ? 1 : 0,
      createdAt: Store.ts(now),
    });
    if (row) return { id: row.id, created: true };
    const existing = this._getPostByPlatformId.get(String(platformPostId));
    return { id: existing.id, created: false };
  }

  listPosts({ limit = 100 } = {}) {
    return this._listPosts.all(Math.min(Math.max(limit, 1), 500));
  }

  // selections ------------------------------------------------------------

  /** Insert an immutable selection. gradeable is derived here from the §7
   * rule (captured_at < kickoff_utc) -- never passed in by a caller that
   * could get it wrong. */
  insertSelection({ postId, sourceId, competition = null, home, away, kickoffUtc, market, pick, line = null, claimedOdds = null, verifiedOdds = null, verifiedOddsSource = null, capturedAt, now = new Date() }) {
    if (!postId || !sourceId || !home || !away || !kickoffUtc || !market || !pick) {
      throw new Error('postId, sourceId, home, away, kickoffUtc, market, and pick are required');
    }
    if (claimedOdds !== null && claimedOdds !== undefined && !(claimedOdds > 1.0)) throw new Error('claimedOdds must be > 1.0 or null');
    if (verifiedOdds !== null && verifiedOdds !== undefined && !(verifiedOdds > 1.0)) throw new Error('verifiedOdds must be > 1.0 or null');
    const gradeable = new Date(capturedAt).getTime() < new Date(kickoffUtc).getTime() ? 1 : 0;
    const info = this._insertSelection.run({
      postId,
      sourceId,
      competition: competition ?? null,
      home,
      away,
      kickoffUtc,
      market,
      pick,
      line: line ?? null,
      claimedOdds: claimedOdds ?? null,
      verifiedOdds: verifiedOdds ?? null,
      verifiedOddsSource: verifiedOddsSource ?? null,
      closingOdds: null,
      gradeable,
      createdAt: Store.ts(now),
    });
    return info.lastInsertRowid;
  }

  listSelections({ sourceId }) {
    if (!sourceId) throw new Error('sourceId is required');
    return this._listSelections.all(sourceId);
  }

  // settlements -----------------------------------------------------------

  upsertSettlement({ selectionId, status, payoutFraction = 1.0, settledAt, resultPayload = null, ruleVersion }) {
    const allowed = ['won', 'lost', 'void', 'push', 'ungradeable'];
    if (!allowed.includes(status)) throw new Error(`status must be one of ${allowed.join(', ')}`);
    this._upsertSettlement.run({
      selectionId,
      status,
      payoutFraction,
      settledAt,
      resultPayload: resultPayload === null ? null : JSON.stringify(resultPayload),
      ruleVersion,
    });
  }

  /** The exact shape scoreStrategy() consumes: status, oddsUsed,
   * payoutFraction, settledAt, postId, closingOdds. Gradeable-only, window
   * optional (null = all time). */
  settledSelectionsForSource({ sourceId, windowStart = null }) {
    return this._settledSelectionsForSource.all({ sourceId, windowStart });
  }

  // source_scores ---------------------------------------------------------

  upsertSourceScore({ sourceId, window, score, computedAt = new Date() }) {
    if (!SCORE_WINDOWS.includes(window)) throw new Error(`window must be one of ${SCORE_WINDOWS.join(', ')}`);
    this._upsertSourceScore.run({
      sourceId,
      window,
      nSettled: score.nSettled,
      roi: score.roi,
      roiCiLow: score.roiCiLow,
      roiCiHigh: score.roiCiHigh,
      hitRate: score.hitRate,
      avgOdds: score.avgOdds,
      meanClv: score.meanClv,
      pctPositiveClv: score.pctPositiveClv,
      longestLosingRun: score.longestLosingRun,
      computedAt: Store.ts(computedAt),
    });
  }

  /** Latest all-window score -- the value the notification gate reads
   * (rated = n_settled >= 50 && roi_ci_low > 0). */
  latestAllWindowScore(sourceId) {
    return this._latestAllWindowScore.get(sourceId) ?? null;
  }

  // notifications ---------------------------------------------------------

  /** Queue a push for one post; dedupes so the same post can't be queued
   * twice. */
  queueNotification({ sourceId, postId, now = new Date() }) {
    const info = this._insertNotification.run({ sourceId, postId, createdAt: Store.ts(now) });
    return { queued: info.changes > 0 };
  }

  listPendingNotifications({ limit = 50 } = {}) {
    return this._pendingNotifications.all(Math.min(Math.max(limit, 1), 500));
  }

  markNotificationSent({ id, fcmMessageId, sentAt = new Date() }) {
    this._markNotificationSent.run({ id, fcmMessageId: fcmMessageId ?? null, sentAt: Store.ts(sentAt) });
  }

  markNotificationFailed({ id, sentAt = new Date() }) {
    this._markNotificationFailed.run({ id, sentAt: Store.ts(sentAt) });
  }

  // ingestion_health ------------------------------------------------------

  recordHealth({ platform, status, detail = null, now = new Date() }) {
    if (!HEALTH_STATUSES.includes(status)) throw new Error(`status must be one of ${HEALTH_STATUSES.join(', ')}`);
    this._recordHealth.run({ platform, status, detail: detail ?? null, runAt: Store.ts(now) });
  }

  listHealth({ platform, limit = 20 } = {}) {
    if (!platform) throw new Error('platform is required');
    return this._listHealth.all({ platform, limit: Math.min(Math.max(limit, 1), 500) });
  }

  // app_state (Telegram session persistence) -----------------------------

  getState(key) {
    const row = this._getState.get(key);
    return row ? row.value : null;
  }

  setState(key, value) {
    this._setState.run({ key, value });
  }

  close() {
    this.db.close();
  }
}
