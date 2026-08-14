/**
 * Amendment E -- the Telegram source adapter (Task E3), grammJS
 * (`telegram` npm package, pure-JS MTProto, no API key). One poller per
 * server, driven by the scan loop:
 *
 *   poller.fetchRecentMessages(channelHandle, { minId })
 *
 * `minId` is the last-seen platform post id, persisted by the pipeline in
 * app_state (`telegram.lastMsg.<handle>`) so a re-sync after a DB loss
 * replays only newer messages. `captured_at` is always set by application
 * code at ingest, never parsed from the platform (docs/ARCHITECTURE.md's
 * immutable rule, carried verbatim into this path).
 *
 * The FloodWait rule survives verbatim from the old social path: on a
 * `FloodWaitError`, sleep exactly its `seconds` value, then retry once.
 *
 * The client surface used here is deliberately small (getEntity,
 * getMessages, getMe, connect, disconnect, session.save) so tests can
 * inject a fake client; the real factory lives at the bottom.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { FloodWaitError } from 'telegram/errors/index.js';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One grammJS message -> this project's normalized raw post shape. */
export function normalizeMessage(msg) {
  const id = msg?.id;
  return {
    platformPostId: id === null || id === undefined ? null : String(id),
    postedAt: msg?.date instanceof Date ? msg.date.toISOString() : null,
    text: typeof msg?.message === 'string' ? msg.message : '',
    media: !!msg?.media,
    edited: !!msg?.editDate,
  };
}

/** Create the real grammJS client. `sessionString` may be '' (fresh
 * session -> login flow required, see scripts/make_session.js). */
export async function defaultClientFactory({ apiId, apiHash, sessionString }) {
  return new TelegramClient(new StringSession(sessionString ?? ''), apiId, apiHash, {
    connectionRetries: 3,
    retryDelay: 2000,
  });
}

export class TelegramPoller {
  /**
   * @param {object} opts
   * @param {number|string} opts.apiId Telegram api_id (my.telegram.org)
   * @param {string} opts.apiHash Telegram api_hash
   * @param {string|null} [opts.sessionString] StringSession, from
   *   scripts/make_session.js or the DB's refreshed copy
   * @param {(ms: number) => Promise<void>} [opts.sleepFn] injectable for tests
   */
  constructor({ apiId, apiHash, sessionString = null, sleepFn = sleep }) {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this._sessionString = sessionString ?? null;
    this.sleepFn = sleepFn;
    this.client = null;
  }

  get connected() {
    return !!(this.client && this.client.connected);
  }

  /** The (possibly refreshed) StringSession -- callers persist this to the
   * DB after each successful poll so a redeploy keeps the fresh auth key. */
  get sessionString() {
    return this.client?.session?.save?.() ?? this._sessionString ?? null;
  }

  /** Connect the MTProto client. Injects the factory for tests. */
  async connect({ clientFactory = defaultClientFactory } = {}) {
    this.client = await clientFactory({
      apiId: this.apiId,
      apiHash: this.apiHash,
      sessionString: this.sessionString,
    });
    await this.client.connect();
    return this.client;
  }

  /** True when the session is actually logged in to a user account --
   * a connecting client with a fresh/empty session reports connected but
   * has no user. Returns the user object, or null. */
  async checkAuth() {
    if (!this.client) return null;
    try {
      return await this.client.getMe();
    } catch {
      return null;
    }
  }

  /**
   * Poll one channel for messages newer than `minId` (exclusive), oldest
   * first so the pipeline processes them chronologically. On a
   * FloodWaitError, sleeps exactly the returned seconds then retries once.
   *
   * @returns normalized messages, ascending by platformPostId
   */
  async fetchRecentMessages(channelHandle, { minId = 0, limit = 100, retryFlood = true } = {}) {
    if (!this.client) throw new Error('TelegramPoller: connect() before fetchRecentMessages()');
    const entity = await this.client.getEntity(channelHandle);
    const request = () => this.client.getMessages(entity, { limit, minId });

    let messages;
    try {
      messages = await request();
    } catch (err) {
      if (!(retryFlood && err instanceof FloodWaitError)) throw err;
      const seconds = Number(err.seconds || 5);
      await this.sleepFn(seconds * 1000);
      messages = await request();
    }

    return messages
      .map(normalizeMessage)
      .filter((m) => m.platformPostId !== null)
      .sort((a, b) => Number(a.platformPostId) - Number(b.platformPostId));
  }

  async stop() {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        // already disconnected -- nothing to do
      }
    }
    this.client = null;
  }
}

/** Small re-export so pipeline code can duck-type `err instanceof` checks
 * against the same error class the poller wraps (tests construct it with
 * `{ request: {}, capture: <seconds> }`). */
export { FloodWaitError };
