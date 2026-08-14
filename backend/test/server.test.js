import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 31000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'tipster-server-'));
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: join(dir, 'test.db'),
      SCAN_INTERVAL_MS: '60000',
      TELEGRAM_CHANNELS: '',
      ESPN_LEAGUES: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d;
  });
  return { proc, dir, stderr };
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not become healthy in time');
}

test('server boots with no telegram configured and serves the full API', async () => {
  const { proc, dir } = boot();
    await waitForHealth();
    try {

    const status = await (await fetch(`${BASE}/api/status`)).json();
    assert.equal(status.service, 'tipster-agg-backend');
    assert.equal(status.telegram.configured, false);
    assert.equal(status.telegram.state, 'not configured');
    assert.equal(status.scanIntervalMs, 60000);
    assert.deepEqual(status.leagues, []);
    assert.deepEqual(status.channels, []);

    const sources = await (await fetch(`${BASE}/api/sources`)).json();
    assert.ok(Array.isArray(sources.sources));

    const posts = await (await fetch(`${BASE}/api/posts?limit=10`)).json();
    assert.ok(Array.isArray(posts.posts));

    const reg = await fetch(`${BASE}/api/register-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-server-test', appInstallId: 'app-1', platform: 'android' }),
    });
    assert.equal(reg.status, 200);
    assert.deepEqual(await reg.json(), { ok: true });

    const bad = await fetch(`${BASE}/api/register-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    const notFound = await fetch(`${BASE}/api/nope`);
    assert.equal(notFound.status, 404);

    const refresh = await fetch(`${BASE}/refresh`, { method: 'POST' });
    assert.equal(refresh.status, 200);
    const refreshBody = await refresh.json();
    assert.equal(refreshBody.ok, true);
    assert.ok(refreshBody.lastScanAt);
    assert.equal(refreshBody.lastScanError, null);
    assert.equal(refreshBody.summary.postsIngested, 0);
    assert.equal(refreshBody.summary.selectionsSettled, 0);
  } finally {
    proc.kill();
    await new Promise((r) => {
      proc.once('exit', r);
      setTimeout(r, 5000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
