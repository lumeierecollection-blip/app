/**
 * Amendment E -- the no-API backend server (Task E7). Plain node:http, no
 * framework, matching the codebase's Node port style. One process:
 *
 *  - a self-scheduled scan loop (ScanRunner from lib/pipeline.js), guarded
 *    against overlap, every SCAN_INTERVAL_MS;
 *  - a small JSON API for the Flutter app: /api/health, /api/status,
 *    /api/sources, /api/posts, POST /api/register-device, POST /refresh.
 *
 * The old odds-market routes (/api/slips, /api/strategies,
 * /api/manual-check*, Supabase keys) are retired from this file per
 * docs/AMENDMENT_E.md §"Retired from active service".
 *
 * Boot order: DB -> Telegram poller (session from DB, else env) -> scan.
 * Telegram is NOT required to boot: a missing session is reported loudly
 * by /api/status (hard error, never "no posts") and every other function
 * keeps working.
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { Store } from './lib/store.js';
import { TelegramPoller } from './lib/telegram.js';
import { ScanRunner } from './lib/pipeline.js';
import { createFcmNotifier } from './lib/notify.js';
import { fetchScoreboard } from './lib/espn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'tipster.db');
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 5 * 60 * 1000);
const TELEGRAM_API_ID = process.env.TELEGRAM_API_ID;
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const TELEGRAM_SESSION_ENV = process.env.TELEGRAM_SESSION;
const CHANNELS = splitEnv(process.env.TELEGRAM_CHANNELS, []);
const LEAGUES = splitEnv(process.env.ESPN_LEAGUES, ['eng.1']);
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

const store = new Store(DB_PATH);
const telegramSession = store.getState('telegram.session') ?? TELEGRAM_SESSION_ENV ?? null;
const poller =
  TELEGRAM_API_ID && TELEGRAM_API_HASH
    ? new TelegramPoller({ apiId: TELEGRAM_API_ID, apiHash: TELEGRAM_API_HASH, sessionString: telegramSession })
    : null;
const notifier = FIREBASE_SERVICE_ACCOUNT_JSON ? createFcmNotifier(FIREBASE_SERVICE_ACCOUNT_JSON) : null;

const runner = new ScanRunner({ store, poller, espn: { fetchScoreboard }, notify: notifier });

let cache = {
  running: false,
  lastScanAt: null,
  lastScanSummary: null,
  lastScanError: null,
  telegramState: null, // 'not configured' | 'ok' | 'auth failed' | error message
};

async function connectTelegramOnce() {
  if (!poller) return 'not configured';
  if (poller.connected) return 'ok';
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram connect timed out')), 30000));
  try {
    await Promise.race([poller.connect(), timeout]);
    const user = await poller.checkAuth();
    if (!user) return 'session invalid or expired (re-run scripts/make_session.js and update TELEGRAM_SESSION)';
    const refreshed = poller.sessionString;
    if (refreshed) store.setState('telegram.session', refreshed);
    return 'ok';
  } catch (err) {
    return String(err?.message ?? err);
  }
}

async function scan() {
  if (cache.running) return;
  cache.running = true;
  try {
    const telegramState = await connectTelegramOnce();
    cache.telegramState = telegramState;

    const summary = await runner.run({ channels: telegramState === 'ok' ? CHANNELS : [], leagues: LEAGUES });
    cache.lastScanAt = new Date().toISOString();
    cache.lastScanSummary = summary;
    cache.lastScanError = null;
  } catch (err) {
    cache.lastScanError = String(err?.message || err);
    console.error('scan failed:', cache.lastScanError);
  } finally {
    cache.running = false;
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  setCors(req, res);
  if (req.method === 'OPTIONS') return;

  try {
    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, { ok: true, service: 'tipster-agg-backend', uptime: Math.round(process.uptime()) });
    }

    if (req.method === 'GET' && path === '/api/status') {
      const telegramHealth = store.listHealth({ platform: 'telegram', limit: 3 });
      return json(res, 200, {
        service: 'tipster-agg-backend',
        uptime: Math.round(process.uptime()),
        scanIntervalMs: SCAN_INTERVAL_MS,
        leagues: LEAGUES,
        channels: CHANNELS,
        telegram: {
          configured: !!poller,
          sessionConfigured: !!(telegramSession ?? store.getState('telegram.session')),
          state: cache.telegramState,
          lastHealth: telegramHealth[0] ?? null,
        },
        firebase: { configured: !!notifier },
        lastScanAt: cache.lastScanAt,
        lastScanError: cache.lastScanError,
        lastScanSummary: cache.lastScanSummary,
      });
    }

    if (req.method === 'GET' && path === '/api/sources') {
      const sources = store.listSources().map((s) => {
        const score = store.latestAllWindowScore(s.id);
        return {
          handle: s.handle,
          displayName: s.display_name,
          active: s.active,
          firstSeen: s.first_seen,
          score: score
            ? {
                nSettled: score.n_settled,
                roi: score.roi,
                roiCiLow: score.roi_ci_low,
                roiCiHigh: score.roi_ci_high,
                hitRate: score.hit_rate,
                avgOdds: score.avg_odds,
                meanClv: score.mean_clv,
                pctPositiveClv: score.pct_positive_clv,
                longestLosingRun: score.longest_losing_run,
                rated: score.n_settled >= 50,
                disqualified: !!score.disqualified,
                disqualificationReasons: score.disqualification_reasons ? JSON.parse(score.disqualification_reasons) : [],
                computedAt: score.computed_at,
              }
            : null,
        };
      });
      return json(res, 200, { sources });
    }

    if (req.method === 'GET' && path === '/api/posts') {
      const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
      return json(res, 200, { posts: store.listPosts({ limit }) });
    }

    if (req.method === 'POST' && path === '/api/register-device') {
      const body = await readJsonBody(req);
      const { token, appInstallId, platform } = body;
      if (!token) return json(res, 400, { error: 'token is required' });
      store.registerDevice({ token, appInstallId: appInstallId ?? null, platform: platform ?? 'android' });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/refresh') {
      await scan();
      return json(res, 200, {
        ok: true,
        lastScanAt: cache.lastScanAt,
        lastScanError: cache.lastScanError,
        summary: cache.lastScanSummary,
      });
    }

    if (req.method === 'GET' && (path === '/' || path === '')) {
      return json(res, 200, {
        service: 'tipster-agg-backend',
        endpoints: [
          'GET /api/health',
          'GET /api/status',
          'GET /api/sources',
          'GET /api/posts?limit=',
          'POST /api/register-device',
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts;
}

async function bootstrap() {
  await scan();
  setInterval(async () => {
    try {
      await scan();
    } catch (err) {
      console.error('scan failed:', err?.message || err);
    }
  }, SCAN_INTERVAL_MS);
  console.log(
    `scanner: every ${Math.round(SCAN_INTERVAL_MS / 1000)}s · leagues: ${LEAGUES.join(', ')} · channels: ${CHANNELS.join(', ')}`,
  );
}

const server = http.createServer(handle);

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
export function start() {
  server.listen(PORT, () => {
    console.log(`tipster-agg-backend listening on :${PORT}`);
    void bootstrap();
  });
}

if (isMain) {
  start();
}

export { server, cache, store };
