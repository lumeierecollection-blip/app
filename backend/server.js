import http from 'node:http';

import { NoSharpPriceError, evaluateManualCheck } from './lib/manualCheck.js';
import { ingestFixturesAndOdds, rescoreAllStrategies, reportPendingSettlements } from './lib/scan.js';
import { fetchLatestSharpQuotes, fetchSlips, fetchStrategyScores, recordManualCheck } from './lib/supabase.js';

const PORT = Number(process.env.PORT || 8080);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 5 * 60 * 1000);
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const ODDS_PROVIDER_API_KEY = process.env.ODDS_PROVIDER_API_KEY;
const COMPETITIONS = splitEnv(process.env.COMPETITIONS, ['Premier League']);

let cache = { generatedAt: null, slips: [], strategies: [], pendingSettlements: 0, lastScanError: null, running: false };
let scanChain = Promise.resolve();
let quotaConsumedThisScan = 0;

async function scan() {
  if (cache.running) return scanChain;
  const job = (async () => {
    cache.running = true;
    let lastScanError = null;
    try {
      if (!API_FOOTBALL_KEY || !ODDS_PROVIDER_API_KEY) {
        throw new Error('API_FOOTBALL_KEY and ODDS_PROVIDER_API_KEY must both be set to scan');
      }

      let requestsThisScan = 0;
      for (const competition of COMPETITIONS) {
        await ingestFixturesAndOdds({
          apiFootballKey: API_FOOTBALL_KEY,
          oddsPapiKey: ODDS_PROVIDER_API_KEY,
          competition,
        });
        requestsThisScan += 1;
      }
      quotaConsumedThisScan = requestsThisScan;

      const pendingSettlements = await reportPendingSettlements();
      await rescoreAllStrategies();

      const [strategies, slips] = await Promise.all([fetchStrategyScores(), fetchSlips()]);

      cache = {
        generatedAt: new Date().toISOString(),
        strategies,
        slips,
        pendingSettlements,
        lastScanError: null,
        running: false,
      };
    } catch (err) {
      lastScanError = String(err?.message || err);
      console.error('scan failed:', lastScanError);
      cache = { ...cache, lastScanError, running: false };
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
  if (req.method === 'OPTIONS') return;

  try {
    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, {
        ok: true,
        service: 'tipster-aggregator-backend',
        uptime: Math.round(process.uptime()),
      });
    }

    if (req.method === 'GET' && path === '/api/status') {
      return json(res, 200, {
        service: 'tipster-aggregator-backend',
        uptime: Math.round(process.uptime()),
        scanIntervalMs: SCAN_INTERVAL_MS,
        competitions: COMPETITIONS,
        generatedAt: cache.generatedAt,
        pendingSettlements: cache.pendingSettlements,
        lastScanError: cache.lastScanError,
        apiRequestsLastScan: quotaConsumedThisScan,
      });
    }

    if (req.method === 'GET' && path === '/api/slips') {
      const stale = !cache.generatedAt || Date.now() - new Date(cache.generatedAt).getTime() > CACHE_TTL_MS;
      if (stale) await scan();
      return json(res, 200, { generatedAt: cache.generatedAt, slips: cache.slips });
    }

    if (req.method === 'GET' && path === '/api/strategies') {
      const stale = !cache.generatedAt || Date.now() - new Date(cache.generatedAt).getTime() > CACHE_TTL_MS;
      if (stale) await scan();
      return json(res, 200, { generatedAt: cache.generatedAt, strategies: cache.strategies });
    }

    if (req.method === 'GET' && path === '/api/manual-check/fair-price') {
      const fixtureId = url.searchParams.get('fixture');
      const market = url.searchParams.get('market');
      if (!fixtureId || !market) return json(res, 400, { error: 'fixture and market query params are required' });

      const quotes = await fetchLatestSharpQuotes({ fixtureId, market });
      if (quotes.length === 0) return json(res, 404, { error: `no sharp-book price yet for fixture ${fixtureId} market ${market}` });

      const { devig, fairOdds } = await import('./lib/devig.js');
      const sharpOdds = Object.fromEntries(quotes.map((q) => [q.selection, q.odds]));
      const fairProbs = devig(sharpOdds);
      const fairPrices = Object.fromEntries(Object.entries(fairProbs).map(([sel, p]) => [sel, fairOdds(p)]));
      return json(res, 200, { fixtureId, market, fairPrices });
    }

    if (req.method === 'POST' && path === '/api/manual-check') {
      const body = await readJsonBody(req);
      const { fixture, market, pick, offeredOdds, bookmaker, line } = body;
      if (!fixture || !market || !pick || !offeredOdds || !bookmaker) {
        return json(res, 400, { error: 'fixture, market, pick, offeredOdds, and bookmaker are required' });
      }

      const quotes = await fetchLatestSharpQuotes({ fixtureId: fixture, market });
      try {
        const result = evaluateManualCheck({
          quotes,
          fixtureId: fixture,
          market,
          pick,
          enteredOdds: Number(offeredOdds),
          enteredBookmaker: bookmaker,
          now: new Date(),
          line: line ?? null,
        });
        const id = await recordManualCheck(result);
        return json(res, 200, {
          id,
          ...result,
          rejections: result.rejections.map((r) => `${r.gate}: ${r.reason}`),
        });
      } catch (err) {
        if (err instanceof NoSharpPriceError) return json(res, 404, { error: err.message });
        return json(res, 400, { error: err.message });
      }
    }

    if (req.method === 'POST' && path === '/refresh') {
      await scan();
      return json(res, 200, {
        ok: true,
        generatedAt: cache.generatedAt,
        slipCount: cache.slips.length,
        strategyCount: cache.strategies.length,
        lastScanError: cache.lastScanError,
      });
    }

    if (req.method === 'GET' && (path === '/' || path === '')) {
      return json(res, 200, {
        service: 'tipster-aggregator-backend',
        endpoints: [
          'GET /api/slips',
          'GET /api/strategies',
          'GET /api/manual-check/fair-price?fixture=&market=',
          'POST /api/manual-check',
          'GET /api/health',
          'GET /api/status',
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
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
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
    `scanner: every ${Math.round(SCAN_INTERVAL_MS / 1000)}s · competitions: ${COMPETITIONS.join(', ')} · ` +
      `keys ${API_FOOTBALL_KEY && ODDS_PROVIDER_API_KEY ? 'configured' : 'MISSING'}`,
  );
}

const server = http.createServer(handle);
server.listen(PORT, () => {
  console.log(`tipster-aggregator-backend listening on :${PORT}`);
  void bootstrap();
});
