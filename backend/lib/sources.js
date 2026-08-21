/**
 * Amendment F -- credential-free sources, ported from tradeapp's
 * lib/sources.js technique-for-technique. The whole point (user-directed,
 * "I want to see data"): every source here works with ZERO setup -- no
 * api_id/api_hash, no session string, no burner accounts.
 *
 *  - fetchTelegramPreview(): reads PUBLIC Telegram channels through the
 *    t.me/s/<channel> web preview (an HTTP GET + HTML parse, exactly how
 *    tradeapp reads its channels). Private channels have no preview and are
 *    unreachable by design -- that is the honest trade for zero credentials.
 *  - generateFixturePulse(): tradeapp's "pulse" pattern applied to football
 *    -- real ESPN fixtures (teams, kickoff, live odds) rendered as feed
 *    entries so the app shows data even before any tipster channel is
 *    configured. These entries are labeled 'fixture-pulse', carry no picks,
 *    and never feed scoring.
 */

const PREVIEW_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** Fetch recent public posts from each channel's t.me/s preview page.
 * @param {string[]} channels channel usernames without '@'
 * @param {{fetchFn?: Function, timeoutMs?: number}} [opts]
 * @returns {Array<{id, channel, text, postedAt, url}>} raw posts, newest
 *   last per channel. A failing/unavailable channel returns nothing for
 *   itself and never breaks the others (same best-effort rule as tradeapp).
 */
export async function fetchTelegramPreview(channels, { fetchFn = globalThis.fetch, timeoutMs = 25000 } = {}) {
  const posts = [];
  await Promise.all(
    channels.map(async (channel) => {
      try {
        const res = await fetchFn(`https://t.me/s/${channel}`, {
          headers: { 'User-Agent': PREVIEW_UA },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return;
        const html = await res.text();
        posts.push(...parseTelegramHtml(channel, html));
      } catch {
        // Channel may be private, rate-limited, or preview unavailable.
      }
    }),
  );
  return posts;
}

/** Parse one t.me/s/<channel> page's HTML into raw posts. Each message's
 * scope is sliced between consecutive `data-post` markers (more robust than
 * one greedy regex across the whole page), then the timestamp and message
 * text are pulled from the slice. Posts with no text (media-only) are
 * skipped -- there is nothing to parse. */
export function parseTelegramHtml(channel, html) {
  const posts = [];
  const markerRe = /<div class="tgme_widget_message[^"]*"[^>]*data-post="([^"]+)"/g;
  const marks = [...html.matchAll(markerRe)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : html.length;
    const block = html.slice(start, end);
    const id = marks[i][1];

    // The <time datetime="..."> element carries the real post time; fall
    // back to now() only when a shape change removes it.
    const t = block.match(/<time[^>]*datetime="([^"]+)"/i);
    const parsedDate = t ? new Date(t[1]) : null;
    const postedAt =
      parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : new Date().toISOString();

    const m = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const text = m ? cleanHtml(m[1]) : '';
    if (!text) continue;

    posts.push({ id: `tg-${id}`, channel, text, postedAt, url: `https://t.me/${id}` });
  }
  return posts;
}

function cleanHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Real upcoming fixtures as feed entries -- tradeapp's pulse pattern.
 * Every value shown is real ESPN data; nothing is invented. Entries carry
 * `selectionCount: 0` and are excluded from scoring by their handle. */
export function generateFixturePulse(events, { limit = 10, now = () => new Date() } = {}) {
  const upcoming = events
    .filter((e) => e.status?.state === 'pre' && e.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, limit);

  return upcoming.map((event) => ({
    id: `pulse-${event.id}`,
    handle: 'fixture-pulse',
    displayName: 'Fixture watch',
    text: fixturePulseText(event),
    postedAt: event.date,
    capturedAt: now().toISOString(),
    url: '',
    selectionCount: 0,
  }));
}

function fixturePulseText(event) {
  const kickoff = new Date(event.date);
  const when = Number.isNaN(kickoff.getTime())
    ? event.date
    : `${kickoff.toUTCString().slice(0, 22)} UTC`;
  const lines = [
    `${event.home.name ?? '?'} vs ${event.away.name ?? '?'}`,
    `${event.league} · kicks off ${when}`,
  ];
  const ml = event.odds?.moneyline;
  const price = (o) => o?.close ?? o?.open ?? null;
  const prices = ml ? [price(ml.home), price(ml.draw), price(ml.away)] : [];
  if (event.odds && prices.every((p) => typeof p === 'number' && p > 1)) {
    lines.push(`${event.odds.provider}: home ${prices[0]} · draw ${prices[1]} · away ${prices[2]}`);
  }
  return lines.join('\n');
}
