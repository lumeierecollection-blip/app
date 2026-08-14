import test from 'node:test';
import assert from 'node:assert/strict';

import { TelegramPoller, normalizeMessage, FloodWaitError } from '../lib/telegram.js';

function fakeClient({ getMessages, getMe, connected = true } = {}) {
  const session = { save: () => 'fake-session-string' };
  return {
    connected,
    session,
    getEntity: async (handle) => ({ id: 123, username: handle }),
    getMessages: getMessages ?? (async () => []),
    getMe: async () => (typeof getMe === 'function' ? await getMe() : getMe ?? null),
    connect: async () => {},
    disconnect: async () => {},
  };
}

test('normalizeMessage maps a grammJS message to the raw post shape', () => {
  const msg = {
    id: 42,
    date: new Date('2026-08-14T10:00:00.000Z'),
    message: 'Arsenal to beat Coventry @ 1.35',
    media: undefined,
  };
  assert.deepEqual(normalizeMessage(msg), {
    platformPostId: '42',
    postedAt: '2026-08-14T10:00:00.000Z',
    text: 'Arsenal to beat Coventry @ 1.35',
    media: false,
    edited: false,
  });
});

test('normalizeMessage survives a shape change (missing fields become null/false)', () => {
  const msg = { message: 'text only' };
  assert.deepEqual(normalizeMessage(msg), {
    platformPostId: null,
    postedAt: null,
    text: 'text only',
    media: false,
    edited: false,
  });
});

test('fetchRecentMessages returns normalized messages ascending by id and passes minId through', async () => {
  const sent = [];
  const client = fakeClient({
    getMessages: async (_entity, opts) => {
      sent.push(opts);
      return [
        { id: 5, date: new Date('2026-08-14T10:05:00.000Z'), message: 'c' },
        { id: 3, date: new Date('2026-08-14T10:03:00.000Z'), message: 'a' },
        { id: null, message: 'junk' },
        { id: 4, date: new Date('2026-08-14T10:04:00.000Z'), message: 'b' },
      ];
    },
  });
  const poller = new TelegramPoller({ apiId: 1, apiHash: 'a', sessionString: null });
  await poller.connect({ clientFactory: async () => client });

  const messages = await poller.fetchRecentMessages('SomeChannel', { minId: 12, limit: 50 });
  assert.deepEqual(messages.map((m) => m.platformPostId), ['3', '4', '5']);
  assert.deepEqual(sent[0], { limit: 50, minId: 12 });
  assert.equal(poller.connected, true);
});

test('FloodWaitError sleeps exactly the returned seconds then retries once', async () => {
  const sleeps = [];
  const sleepsDone = [];
  let calls = 0;
  const client = fakeClient({
    getMessages: async (_entity, opts) => {
      calls += 1;
      if (calls === 1) throw new FloodWaitError({ request: {}, capture: 17 });
      return [{ id: 7, date: new Date('2026-08-14T10:07:00.000Z'), message: 'ok' }];
    },
  });
  const poller = new TelegramPoller({
    apiId: 1,
    apiHash: 'a',
    sessionString: null,
    sleepFn: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  await poller.connect({ clientFactory: async () => client });

  const messages = await poller.fetchRecentMessages('Channel');
  assert.deepEqual(sleeps, [17000], 'must sleep exactly the returned seconds');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].platformPostId, '7');
});

test('FloodWaitError is not retried when retryFlood is false', async () => {
  const client = fakeClient({
    getMessages: async () => {
      throw new FloodWaitError({ request: {}, capture: 17 });
    },
  });
  const poller = new TelegramPoller({ apiId: 1, apiHash: 'a', sessionString: null });
  await poller.connect({ clientFactory: async () => client });

  await assert.rejects(() => poller.fetchRecentMessages('Channel', { retryFlood: false }), FloodWaitError);
});

test('checkAuth resolves the user, or null when the session is not logged in', async () => {
  const poller = new TelegramPoller({ apiId: 1, apiHash: 'a', sessionString: null });

  await poller.connect({
    clientFactory: async () => fakeClient({ getMe: async () => ({ username: 'me' }) }),
  });
  assert.deepEqual(await poller.checkAuth(), { username: 'me' });

  await poller.connect({
    clientFactory: async () =>
      fakeClient({
        getMe: async () => {
          throw new Error('AUTH_KEY_UNREGISTERED');
        },
      }),
  });
  assert.equal(await poller.checkAuth(), null);
});

test('sessionString returns the connected client session (fresh auth key)', async () => {
  const poller = new TelegramPoller({ apiId: 1, apiHash: 'a', sessionString: 'stale-session' });
  await poller.connect({ clientFactory: async () => fakeClient() });
  assert.equal(poller.sessionString, 'fake-session-string');
});

test('fetchRecentMessages before connect throws a clear error', async () => {
  const poller = new TelegramPoller({ apiId: 1, apiHash: 'a', sessionString: null });
  await assert.rejects(() => poller.fetchRecentMessages('Channel'), /connect\(\)/);
});
