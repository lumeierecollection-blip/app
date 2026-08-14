/**
 * Amendment E -- the scan pipeline (Task E5): one cycle of the
 * "Telegram in, score out" loop. Order matters and is deliberate:
 *
 *  1. Fetch ESPN fixtures/results FIRST (fixtures for extraction, results
 *     for settlement) so verified odds are known at selection-insert time
 *     and selections stay fully immutable (the one caveat being the
 *     post-match closing line, which lives on the settlements row).
 *  2. Ingest Telegram posts -> posts -> extracted selections.
 *  3. Settle pending (kicked-off, un-settled) selections against real
 *     results, matched by the ESPN event id -- no name guessing.
 *  4. Recompute the source_scores per window, plus the §7 source-level
 *     disqualifiers (lib/disqualifiers.js).
 *  5. Queue + deliver FCM pushes for new posts from rated sources.
 *
 * Every external fetch records an ingestion_health row (ok/empty/error are
 * three different facts). The runner's collaborators are injected so the
 * integration tests run the real store + scoring + settlement math against
 * fake network layers.
 */

import { Store } from './store.js';
import { extractPicks } from './extract.js';
import { settleSelection, RULE_VERSION } from './settlement.js';
import { scoreStrategy } from './scoring.js';
import { disqualificationsForSource, sourceIsNotifiable } from './disqualifiers.js';
import { upcomingFixtures, resultPayload, dateKey, dateFromKey } from './espn.js';

/** A selection is settleable once its kickoff is this far in the past
 * (Task B6's sweep window). */
export const SETTLE_GRACE_MS = 150 * 60 * 1000;
export const SCORE_WINDOWS = [
  ['all', null],
  ['90d', (now) => new Date(now.getTime() - 90 * 24 * 3600 * 1000).toISOString()],
  ['30d', (now) => new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString()],
];

/** The reference book's closing line for a pick within an ESPN event's
 * odds block. btts has no line block; totals/moneyline/spread do. */
export function marketLineOdds(event, market, pick) {
  const odds = event?.odds;
  if (!odds) return null;
  if (market === 'moneyline') return odds.moneyline?.[pick]?.close ?? null;
  if (market === 'totals') return odds.totals?.[pick]?.close ?? null;
  if (market === 'asian_handicap') return odds.spread?.[pick]?.close ?? null;
  return null;
}

function eventById(events, id) {
  return events.find((e) => e.id === String(id)) ?? null;
}

export class ScanRunner {
  /**
   * @param {object} deps
   * @param {Store} deps.store
   * @param {{fetchRecentMessages: Function}} deps.poller Telegram poller
   * @param {{fetchScoreboard: Function}} deps.espn ESPN adapter
   * @param {Function} [deps.extract]
   * @param {Function} [deps.settle]
   * @param {Function} [deps.notify] ({token,title,body,data}) => Promise
   * @param {() => Date} [deps.now]
   */
  constructor({ store, poller, espn, extract = extractPicks, settle = settleSelection, notify = null, now = () => new Date() }) {
    this.store = store;
    this.poller = poller;
    this.espn = espn;
    this.extract = extract;
    this.settle = settle;
    this.notify = notify;
    this.now = now;
  }

  async run({ channels, leagues }) {
    const store = this.store;
    const startedAt = this.now();
    this._newPostsBySource = {};
    const summary = {
      startedAt: Store.ts(startedAt),
      leagues,
      channels,
      espnEvents: 0,
      postsIngested: 0,
      newPosts: 0,
      selectionsInserted: 0,
      selectionsSettled: 0,
      sourcesScored: 0,
      notificationsQueued: 0,
      notificationsSent: 0,
    };

    // 1. Fetch fixtures + today's results per league, once per scan.
    const allEvents = [];
    for (const league of leagues) {
      try {
        const { events } = await this.espn.fetchScoreboard({ league });
        allEvents.push(...events);
        summary.espnEvents += events.length;
        store.recordHealth({
          platform: 'espn',
          status: events.length ? 'ok' : 'empty',
          detail: `${league}: ${events.length} events`,
          now: startedAt,
        });
      } catch (err) {
        store.recordHealth({
          platform: 'espn',
          status: 'error',
          detail: `${league}: ${String(err?.message ?? err)}`,
          now: startedAt,
        });
      }
    }
    const fixtures = upcomingFixtures(allEvents);

    // 2. Ingest Telegram posts -> selections.
    for (const channel of channels) {
      const source = store.upsertSource({ handle: channel });
      const lastState = store.getState(`telegram.lastMsg.${channel}`);
      let minId = Number(lastState ?? 0) || 0;
      const createdPostIds = [];

      try {
        const messages = await this.poller.fetchRecentMessages(channel, { minId });
        let lastId = minId;
        summary.postsIngested += messages.length;

        for (const msg of messages) {
          const numericId = Number(msg.platformPostId);
          if (!Number.isFinite(numericId)) continue;
          lastId = Math.max(lastId, numericId);

          const capturedAt = Store.ts(this.now());
          const { id: postId, created } = store.insertPost({
            sourceId: source.id,
            platformPostId: msg.platformPostId,
            capturedAt,
            postedAt: msg.postedAt,
            rawText: msg.text,
            media: msg.media,
            editedFlag: msg.edited,
            now: startedAt,
          });
          if (!created) continue;

          summary.newPosts += 1;
          createdPostIds.push(postId);

          const { picks } = this.extract(msg.text, fixtures, { media: msg.media });
          for (const pick of picks) {
            const event = eventById(allEvents, pick.providerEventId);
            const verified = marketLineOdds(event, pick.market, pick.pick);
            store.insertSelection({
              postId,
              sourceId: source.id,
              providerEventId: pick.providerEventId,
              competition: pick.competition,
              home: pick.home,
              away: pick.away,
              kickoffUtc: pick.kickoffUtc,
              market: pick.market,
              pick: pick.pick,
              line: pick.line,
              claimedOdds: pick.claimedOdds,
              verifiedOdds: verified,
              verifiedOddsSource: verified ? 'draftkings' : null,
              capturedAt,
              now: startedAt,
            });
            summary.selectionsInserted += 1;
          }
        }

        store.setState(`telegram.lastMsg.${channel}`, String(lastId));
        if (this.poller?.sessionString) {
          store.setState('telegram.session', this.poller.sessionString);
        }
        store.recordHealth({
          platform: 'telegram',
          status: messages.length ? 'ok' : 'empty',
          detail: `${channel}: ${messages.length} messages, ${summary.newPosts} new`,
          now: startedAt,
        });

        // Remember this scan's new posts per source for the notification gate.
        this._newPostsBySource[source.id] = createdPostIds;
      } catch (err) {
        store.recordHealth({
          platform: 'telegram',
          status: 'error',
          detail: `${channel}: ${String(err?.message ?? err)}`,
          now: startedAt,
        });
      }
    }

    // 3. Settle pending selections, matched by provider_event_id.
    const cutoff = new Date(startedAt.getTime() - SETTLE_GRACE_MS);
    const pending = store.listPendingSelections({ before: Store.ts(cutoff) });
    const byDay = new Map();
    for (const sel of pending) {
      const key = `${sel.competition ?? ''}|${dateKey(new Date(sel.kickoff_utc))}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(sel);
    }

    for (const [key, selections] of byDay) {
      const [league, day] = key.split('|');
      if (!league) continue;
      let events = [];
      try {
        const fetched = await this.espn.fetchScoreboard({ league, date: dateFromKey(day) });
        events = fetched.events;
      } catch (err) {
        store.recordHealth({
          platform: 'espn',
          status: 'error',
          detail: `settle ${league} ${day}: ${String(err?.message ?? err)}`,
          now: startedAt,
        });
        continue;
      }

      for (const sel of selections) {
        const event = eventById(events, sel.provider_event_id);
        if (!event) continue; // ESPN has no record today -> leave pending, retry later
        const result = resultPayload(event);
        if (!result) continue; // not finished yet -> leave pending

        const outcome = this.settle({ market: sel.market, pick: sel.pick, line: sel.line }, result);
        store.upsertSettlement({
          selectionId: sel.id,
          status: outcome.status,
          payoutFraction: outcome.payoutFraction,
          settledAt: Store.ts(startedAt),
          resultPayload: result,
          ruleVersion: RULE_VERSION,
          closingOdds: marketLineOdds(event, sel.market, sel.pick),
        });
        summary.selectionsSettled += 1;
      }
      store.recordHealth({
        platform: 'espn',
        status: 'ok',
        detail: `settled ${league} ${day}: ${selections.length} pending matched against ${events.length} events`,
        now: startedAt,
      });
    }

    // 4. Score every active source per window.
    for (const source of store.listSources()) {
      if (!source.active) continue;
      const reasons = disqualificationsForSource(store, source.id);
      const now = startedAt;
      for (const [window, windowStartFn] of SCORE_WINDOWS) {
        const windowStart = windowStartFn ? windowStartFn(now) : null;
        const feed = store.settledSelectionsForSource({ sourceId: source.id, windowStart });
        const score = scoreStrategy(feed, { now });
        store.upsertSourceScore({
          sourceId: source.id,
          window,
          score: { ...score, disqualified: reasons.length > 0, disqualificationReasons: reasons },
          computedAt: now,
        });
      }
      summary.sourcesScored += 1;
    }

    // 5. Queue + send pushes for new posts from notifiable sources.
    for (const [sourceId, postIds] of Object.entries(this._newPostsBySource ?? {})) {
      const source = store.listSources().find((s) => s.id === Number(sourceId));
      if (!source) continue;
      if (!sourceIsNotifiable(store.latestAllWindowScore(Number(sourceId)))) continue;
      for (const postId of postIds) {
        const { queued } = store.queueNotification({ sourceId: Number(sourceId), postId, now: startedAt });
        if (queued) summary.notificationsQueued += 1;
      }
    }

    if (this.notify) {
      summary.notificationsSent = await this._drainNotifications({ now: startedAt });
    }

    return summary;
  }

  async _drainNotifications({ now }) {
    const store = this.store;
    const tokens = store.listDeviceTokens();
    const pending = store.listPendingNotifications({ limit: 50 });
    let sent = 0;
    for (const notification of pending) {
      if (tokens.length === 0) {
        store.markNotificationSkipped({ id: notification.id, sentAt: now });
        continue;
      }
      let delivered = 0;
      for (const token of tokens) {
        try {
          await this.notify({
            token,
            title: notification.source_display_name ?? notification.handle,
            body: truncate(notification.raw_text ?? 'new slip posted', 120),
            data: { postId: String(notification.post_id), sourceHandle: notification.handle },
          });
          delivered += 1;
        } catch (err) {
          console.error('fcm send failed:', err?.message ?? err);
        }
      }
      if (delivered > 0) {
        store.markNotificationSent({ id: notification.id, fcmMessageId: null, sentAt: now });
        sent += 1;
      } else {
        store.markNotificationFailed({ id: notification.id, sentAt: now });
      }
    }
    return sent;
  }
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
