import test from 'node:test';
import assert from 'node:assert/strict';

import { createNotifier, createFcmNotifier } from '../lib/notify.js';

test('createNotifier passes the payload through to send', async () => {
  const seen = [];
  const notifier = createNotifier({
    send: async (payload) => {
      seen.push(payload);
      return { ok: true };
    },
  });
  const payload = { token: 'tok-1', title: 'TipMaster', body: 'new slip', data: { postId: '7' } };
  const result = await notifier.sendNotification(payload);
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [payload]);
});

test('createNotifier rejects a missing send function', () => {
  assert.throws(() => createNotifier({}), /send function/);
});

test('createFcmNotifier defers all Firebase work to first send', async () => {
  // Construction must not import firebase-admin or parse anything.
  const notifier = createFcmNotifier('not-json');
  // First send lazily initializes -> the bad JSON only fails at send time.
  await assert.rejects(() => notifier.sendNotification({ token: 't', title: 'x', body: 'y' }), SyntaxError);
});
