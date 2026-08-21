/**
 * Amendment F -- the tradeapp-shaped server (user-directed rewrite: "scrap
 * the current backend and use the same as tradeapp"). Plain node:http, no
 * framework, no database -- state lives in an in-memory cache refreshed by
 * a self-scheduled scan loop guarded against overlap (tradeapp's
 * `cache.running`/`scanChain` pattern), and device tokens / seen posts live
 * in small JSON files. The only dependency is firebase-admin, for optional
 * push -- exactly tradeapp's dependency footprint.
 *
 * The API contract the Flutter app already speaks is unchanged:
 *   GET  /api/health          GET  /api/status
 *   GET  /api/sources         GET  /api/posts?limit=
 *   POST /api/register-device POST /refresh
 *
 * Data flows with ZERO credentials: ESPN scoreboards are key-less, and
 * Telegram channels are read through the public t.me/s preview (no
 * api_id/api_hash/session). Set TELEGRAM_CHANNELS to follow tipster
 * channels; without it the app still shows live fixtures via the
 * fixture-pulse feed entries.
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createAggregator } from './lib/aggregator.js';
import { PushNotifier, pushConfigured, pushStatus } from './lib/push.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 5 * 60 * 1000);
const LEAGUES = splitEnv(process.env.ESPN_LEAGUES, ['eng.1']);
const CHANNELS = splitEnv(process.env.TELEGRAM_CHANNELS, []);
const DEVICE_TOKENS_FILE =
  process.env.DEVICE_TOKENS_FILE || resolve(__dirname, 'device_tokens.json');
const SEEN_POSTS_FILE = process.env.SEEN_POSTS_FILE || resolve(__dirname, 'seen_posts.json');

const aggregator = createAggregator({ leagues: LEAGUES, channels: CHANNELS });
const notifier = new PushNotifier({ tokenFile: DEVICE_TOKENS_FILE, seenFile: SEEN_POSTS_FILE });

let cache = { running: false };
let scanChain = Promise.resolve();
let bootstrapped = false;

async function scan() {
  if (cache.running) return scanChain;
  const job = (async () => {
    cache.running = true;
    try {
      const summary = await aggregator.scan();

      // Push fresh real posts once, after the first scan has bootstrapped.
      // Fixture-pulse entries are display-only and never pushed; the
      // notifier's seen-set does the actual dedupe.
      if (bootstrapped) {
        const fresh = notifier.process(aggregator.state.posts);
        if (fresh.length) {
          const { attempted, ok } = await notifier.push(fresh);
          console.log(`[push] ${fresh.length} new post(s) · ${ok}/${attempted} delivered`);
        }
      }
      return summary;
    } finally {
      cache.running = false;
    }
  })();
  scanChain = job;
  return job;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  setCors(req, res);

  try {
    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, {
        ok: true,
        service: 'tipster-agg-backend',
        uptime: Math.round(process.uptime()),
      });
    }

    if (req.method === 'GET' && path === '/api/status') {
      const snapshot = aggregator.statusSnapshot();
      const push = pushStatus();
      return json(res, 200, {
        service: 'tipster-agg-backend',
        uptime: Math.round(process.uptime()),
        scanIntervalMs: SCAN_INTERVAL_MS,
        ...snapshot,
        firebase: { configured: pushConfigured(), enabled: push.enabled, reason: push.reason ?? null },
        deviceCount: notifier.tokens.length,
      });
    }

    if (req.method === 'GET' && path === '/api/sources') {
      return json(res, 200, aggregator.sourcesPayload());
    }

    if (req.method === 'GET' && path === '/api/posts') {
      // Serve-and-refresh on staleness, like tradeapp's /api/signals: a free
      // host that slept overnight repopulates on the first request instead
      // of serving a stale empty feed.
      const generatedAt = aggregator.state.generatedAt;
      const stale =
        !generatedAt || Date.now() - new Date(generatedAt).getTime() > CACHE_TTL_MS;
      if (stale) {
        await scan();
      }
      const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
      return json(res, 200, { posts: aggregator.postsPayload({ limit }) });
    }

    if (req.method === 'POST' && path === '/api/register-device') {
      const body = await readJsonBody(req);
      const token = String(body.token || '').trim();
      if (!token) return json(res, 400, { error: 'token is required' });
      notifier.register(token);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/unregister-device') {
      const body = await readJsonBody(req);
      const token = String(body.token || '').trim();
      if (!token) return json(res, 400, { error: 'token is required' });
      const removed = notifier.unregister(token);
      return json(res, 200, { ok: true, removed });
    }

    if (req.method === 'POST' && path === '/refresh') {
      const summary = await scan();
      return json(res, 200, {
        ok: true,
        lastScanAt: aggregator.state.lastScanAt,
        lastScanError: aggregator.state.lastScanError,
        summary,
      });
    }

    if (req.method === 'GET' && (path === '/' || path === '')) {
      return json(res, 200, {
        service: 'tipster-agg-backend',
        endpoints: [
          'GET /api/posts',
          'GET /api/sources',
          'GET /api/status',
          'GET /api/health',
          'POST /api/register-device',
          'POST /api/unregister-device',
          'POST /refresh',
        ],
      });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    return json(res, 500, { error: String(err?.message || err) });
  }
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8192) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function splitEnv(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function bootstrap() {
  await notifier.load();
  await scan();
  // Everything already in the seen-file at boot is old news -- never re-push.
  notifier.markSeen(aggregator.state.posts);
  bootstrapped = true;
  setInterval(async () => {
    try {
      await scan();
    } catch (err) {
      console.error('scan failed:', err?.message || err);
    }
  }, SCAN_INTERVAL_MS);
  console.log(
    `scanner: every ${Math.round(SCAN_INTERVAL_MS / 1000)}s · leagues ${LEAGUES.join(', ') || '(none)'} · ` +
      `channels ${CHANNELS.join(', ') || '(none)'} · ` +
      `push ${pushConfigured() ? 'configured' : 'DISABLED (no Firebase credentials)'}`,
  );
}

const server = http.createServer(handle);

export function start() {
  server.listen(PORT, () => {
    console.log(`tipster-agg-backend listening on :${PORT}`);
    void bootstrap();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start();
}

export { server, cache, aggregator, notifier };
