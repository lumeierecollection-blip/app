import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PushNotifier } from '../lib/push.js';

function tempNotifier() {
  const dir = mkdtempSync(join(tmpdir(), 'push-test-'));
  const notifier = new PushNotifier({
    tokenFile: join(dir, 'tokens.json'),
    seenFile: join(dir, 'seen.json'),
  });
  return { dir, notifier };
}

const post = (id) => ({ id, handle: 'tipsterdemo', displayName: '@tipsterdemo', text: 'hello' });

test('register/unregister round-trips through the tokens file', async () => {
  const { dir, notifier } = tempNotifier();
  try {
    assert.equal(notifier.register('tok-a'), true);
    assert.equal(notifier.register('tok-a'), false, 'duplicate ignored');
    assert.equal(notifier.register('  '), false, 'blank ignored');

    const reloaded = new PushNotifier({
      tokenFile: notifier.tokenFile,
      seenFile: notifier.seenFile,
    });
    await reloaded.load();
    assert.deepEqual(reloaded.tokens, ['tok-a']);

    assert.equal(reloaded.unregister('tok-a'), true);
    assert.equal(reloaded.unregister('tok-a'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('process() delivers each post exactly once across restarts', async () => {
  const { dir, notifier } = tempNotifier();
  try {
    const first = notifier.process([post('tg-x/1'), post('tg-x/2')]);
    assert.equal(first.length, 2);
    assert.ok(readFileSync(notifier.seenFile, 'utf8').includes('tg-x/1'), 'seen set persisted');

    const reloaded = new PushNotifier({ tokenFile: notifier.tokenFile, seenFile: notifier.seenFile });
    await reloaded.load();
    const second = reloaded.process([post('tg-x/1'), post('tg-x/3')]);
    assert.deepEqual(second.map((p) => p.id), ['tg-x/3'], 'only unseen posts come back');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push() sends to every device and counts deliveries', async () => {
  const sent = [];
  const sender = async (token, message) => {
    sent.push({ token, message });
    return token === 'bad' ? { error: 'unregistered' } : { ok: true };
  };
  const dir = mkdtempSync(join(tmpdir(), 'push-test-'));
  const notifier = new PushNotifier({
    tokenFile: join(dir, 'tokens.json'),
    seenFile: join(dir, 'seen.json'),
    sender,
  });
  try {
    notifier.register('good');
    notifier.register('bad');
    const result = await notifier.push([post('tg-x/9')]);
    assert.deepEqual(result, { attempted: 2, ok: 1 });
    assert.equal(sent[0].message.notification.title, '@tipsterdemo');
    assert.equal(sent[0].message.data.sourceHandle, 'tipsterdemo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push() with no devices is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-test-'));
  const notifier = new PushNotifier({
    tokenFile: join(dir, 'tokens.json'),
    seenFile: join(dir, 'seen.json'),
  });
  try {
    assert.deepEqual(await notifier.push([post('tg-x/1')]), { attempted: 0, ok: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
