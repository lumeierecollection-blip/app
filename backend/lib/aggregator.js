/**
 * Amendment F -- the in-memory aggregator, replacing the SQLite store +
 * pipeline pair with tradeapp's model: state lives in the cache, a scan
 * rebuilds it, and a restart starts clean (documented consequence of the
 * no-database design; tradeapp accepts the same).
 *
 * One scan:
 *   1. ESPN scoreboards per league -> fixtures (for extraction) + results
 *      (for settlement) + odds (verified price at insert time).
 *   2. t.me/s preview fetch per configured channel -> new posts -> picks.
 *   3. Settle pending selections 150+ min past kickoff against real results,
 *      matched by provider event id -- never by name guessing.
 *   4. Score every channel with lib/scoring.js (ROI, CLV headline) over its
 *      settled feed.
 *
 * Every external fetch records ok/empty/error as three different facts in
 * the status snapshot -- quota exhaustion or a shape change must never look
 * like "no data" (the project's never-silent rule).
 */

import { extractPicks } from './extract.js';
import { settleSelection } from './settlement.js';
import { scoreStrategy } from './scoring.js';
import { fetchScoreboard, upcomingFixtures, resultPayload, dateKey, dateFromKey } from './espn.js';
import { fetchTelegramPreview, generateFixturePulse } from './sources.js';

/** A selection is settleable once its kickoff is this far in the past
 * (Task B6's sweep window, carried over unchanged). */
export const SETTLE_GRACE_MS = 150 * 60 * 1000;

/** The reference closing line for a pick within an ESPN event's odds block
 * (ported verbatim from the retired pipeline). */
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

export function createAggregator({
  leagues = [],
  channels = [],
  espn = { fetchScoreboard },
  fetchChannelPosts = ({ channels }) => fetchTelegramPreview(channels),
  extract = extractPicks,
  settle = settleSelection,
  now = () => new Date(),
  maxPosts = 500,
} = {}) {
  const state = {
    generatedAt: null,
    events: [],
    posts: [], // real ingested posts only; pulse entries are derived per scan
    postKeys: new Set(),
    selections: [], // {id, handle, ...pick fields, verifiedOdds, settlement}
    nextSelectionId: 1,
    channelsState: new Map(), // handle -> {displayName, firstSeen, lastFetch}
    lastScanAt: null,
    lastScanError: null,
    lastScanSummary: null,
  };

  async function scan() {
    const startedAt = now();
    const summary = {
      startedAt: startedAt.toISOString(),
      leagues,
      channels,
      espnEvents: 0,
      espnStatus: {},
      postsFetched: 0,
      newPosts: 0,
      selectionsInserted: 0,
      selectionsSettled: 0,
      errors: [],
    };

    // 1. Fixtures + today's results per league.
    const allEvents = [];
    for (const league of leagues) {
      try {
        const { events } = await espn.fetchScoreboard({ league });
        allEvents.push(...events);
        summary.espnEvents += events.length;
        summary.espnStatus[league] = events.length ? 'ok' : 'empty';
      } catch (err) {
        summary.espnStatus[league] = 'error';
        summary.errors.push(`espn ${league}: ${String(err?.message ?? err)}`);
      }
    }
    state.events = allEvents;
    const fixtures = upcomingFixtures(allEvents);

    // 2. Channel posts via the t.me/s preview -> picks.
    if (channels.length) {
      try {
        const rawPosts = await fetchChannelPosts({ channels });
        summary.postsFetched += rawPosts.length;
        for (const channel of channels) {
          if (!state.channelsState.has(channel)) {
            state.channelsState.set(channel, {
              displayName: `@${channel}`,
              firstSeen: startedAt.toISOString(),
              lastFetch: 'ok',
            });
          }
        }

        for (const post of rawPosts) {
          if (state.postKeys.has(post.id)) continue;
          state.postKeys.add(post.id);

          const capturedAt = now().toISOString();
          const { picks } = extract(post.text, fixtures);
          state.posts.push({
            id: post.id,
            numericId: null,
            handle: post.channel,
            displayName: `@${post.channel}`,
            rawText: post.text,
            postedAt: post.postedAt,
            capturedAt,
            url: post.url ?? '',
            selectionCount: picks.length,
          });
          summary.newPosts += 1;

          for (const pick of picks) {
            const event = eventById(allEvents, pick.providerEventId);
            const verified = marketLineOdds(event, pick.market, pick.pick);
            state.selections.push({
              id: state.nextSelectionId++,
              handle: post.channel,
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
              capturedAt,
              postedAt: post.postedAt,
              settlement: null,
            });
            summary.selectionsInserted += 1;
          }
        }

        // Mark channels the preview returned nothing for (private/renamed)
        // without losing their history.
        const returned = new Set(rawPosts.map((p) => p.channel));
        for (const channel of channels) {
          const cs = state.channelsState.get(channel);
          cs.lastFetch = returned.has(channel) ? 'ok' : 'empty-or-private';
        }
        while (state.posts.length > maxPosts) state.posts.shift();
      } catch (err) {
        summary.errors.push(`telegram preview: ${String(err?.message ?? err)}`);
      }
    }

    // 3. Settle pending selections against real results.
    const cutoff = new Date(startedAt.getTime() - SETTLE_GRACE_MS);
    const pending = state.selections.filter(
      (s) => !s.settlement && s.kickoffUtc && new Date(s.kickoffUtc) < cutoff,
    );
    const byDay = new Map();
    for (const sel of pending) {
      const key = `${sel.competition ?? ''}|${dateKey(new Date(sel.kickoffUtc))}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(sel);
    }
    for (const [key, selections] of byDay) {
      const [league, day] = key.split('|');
      if (!league) continue;
      let events = [];
      try {
        const fetched = await espn.fetchScoreboard({ league, date: dateFromKey(day) });
        events = fetched.events;
      } catch (err) {
        summary.errors.push(`settle ${league} ${day}: ${String(err?.message ?? err)}`);
        continue;
      }
      for (const sel of selections) {
        const event = eventById(events, sel.providerEventId);
        if (!event) continue; // no record that day -> leave pending, retry later
        const result = resultPayload(event);
        if (!result) continue; // not finished yet
        const outcome = settle({ market: sel.market, pick: sel.pick, line: sel.line }, result);
        sel.settlement = {
          status: outcome.status,
          payoutFraction: outcome.payoutFraction,
          settledAt: startedAt.toISOString(),
          closingOdds: marketLineOdds(event, sel.market, sel.pick),
          result,
        };
        summary.selectionsSettled += 1;
      }
    }

    state.generatedAt = startedAt.toISOString();
    state.lastScanAt = state.generatedAt;
    state.lastScanError = summary.errors.length ? summary.errors.join(' | ') : null;
    state.lastScanSummary = summary;
    return summary;
  }

  /** The Slips-tab feed: derived fixture-pulse entries plus real posts,
   * newest first. Pulse entries are regenerated every scan so kickoff times
   * and prices stay live; they never enter scoring (selectionCount 0 and a
   * reserved handle). */
  function postsPayload({ limit = 50 } = {}) {
    const pulse = generateFixturePulse(state.events, { now });
    const merged = [...pulse, ...state.posts].sort(
      (a, b) => new Date(b.capturedAt ?? b.postedAt ?? 0) - new Date(a.capturedAt ?? a.postedAt ?? 0),
    );
    return merged.slice(0, limit).map((p) => ({
      id: p.id,
      handle: p.handle,
      source_display_name: p.displayName ?? p.handle,
      raw_text: p.rawText ?? p.text ?? '',
      posted_at: p.postedAt ?? null,
      captured_at: p.capturedAt ?? null,
      selection_count: p.selectionCount ?? 0,
    }));
  }

  /** The Tipsters-tab list: every tracked channel with its latest score. */
  function sourcesPayload() {
    const sources = [];
    for (const [handle, cs] of state.channelsState) {
      const feed = state.selections
        .filter((s) => s.handle === handle && s.settlement)
        .map((s) => ({
          status: s.settlement.status,
          payoutFraction: s.settlement.payoutFraction,
          oddsUsed: s.verifiedOdds ?? s.claimedOdds ?? null,
          closingOdds: s.settlement.closingOdds,
          settledAt: s.settlement.settledAt,
        }));
      const score = feed.length ? scoreStrategy(feed, { now: now() }) : null;
      sources.push({
        handle,
        displayName: cs.displayName,
        active: true,
        firstSeen: cs.firstSeen,
        score: score ? { ...score, computedAt: state.generatedAt } : null,
      });
    }
    return { sources };
  }

  function statusSnapshot() {
    const telegramStates = [...state.channelsState.values()].map((c) => c.lastFetch);
    return {
      leagues,
      channels,
      espn: state.lastScanSummary?.espnStatus ?? {},
      telegram: {
        configured: channels.length > 0,
        state:
          channels.length === 0
            ? 'not configured'
            : telegramStates.every((s) => s === 'ok')
              ? 'ok'
              : `some channels unreachable: ${[...state.channelsState.values()]
                  .map((c) => `${c.displayName}=${c.lastFetch}`)
                  .join(', ')}`,
      },
      generatedAt: state.generatedAt,
      lastScanAt: state.lastScanAt,
      lastScanError: state.lastScanError,
      lastScanSummary: state.lastScanSummary,
    };
  }

  return {
    scan,
    postsPayload,
    sourcesPayload,
    statusSnapshot,
    get state() {
      return state;
    },
  };
}
