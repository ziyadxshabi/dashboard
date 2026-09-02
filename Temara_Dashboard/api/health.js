/**
 * Public dependency health check. No auth.
 * GET /api/health — Redis, Baserow, n8n in parallel (3s each).
 */
const { applyCors } = require('./_lib/auth-crypto');
const { createApiError } = require('./_lib/validation');

const PING_MS = 3000;

function safeError(err) {
  const msg = String(err?.message || err || 'unreachable');
  if (/token|bearer|authorization|password|secret/i.test(msg)) {
    return 'upstream error';
  }
  return msg.slice(0, 200);
}

async function pingRedis() {
  const started = Date.now();
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) {
    return { ok: false, error: 'Redis not configured', latencyMs: 0 };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['PING']),
      signal: AbortSignal.timeout(PING_MS),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, status: res.status, latencyMs };
    }
    return { ok: true, status: res.status, latencyMs };
  } catch (err) {
    return { ok: false, error: safeError(err), latencyMs: Date.now() - started };
  }
}

async function pingBaserow() {
  const baserowApiUrl = String(process.env.BASEROW_API_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.BASEROW_API_TOKEN || process.env.BASEROW_TOKEN || '').trim();
  if (!baserowApiUrl || !token) {
    return { ok: false, error: 'Baserow not configured', status: 'unconfigured' };
  }

  try {
    const res = await fetch(`${baserowApiUrl}/api/database/databases/`, {
      method: 'GET',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(PING_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: safeError(err) };
  }
}

async function pingN8n() {
  const n8nUrl = String(process.env.N8N_WEBHOOK_BASE_URL || '').replace(/\/+$/, '');
  if (!n8nUrl) {
    return { ok: false, error: 'N8N_WEBHOOK_BASE_URL not configured' };
  }

  try {
    const res = await fetch(`${n8nUrl}/healthz`, {
      method: 'GET',
      signal: AbortSignal.timeout(PING_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: safeError(err) };
  }
}

function classifyService(probe) {
  const httpStatus = typeof probe.status === 'number' ? probe.status : undefined;
  const unconfigured =
    probe.status === 'unconfigured' ||
    /not configured/i.test(String(probe.error || ''));

  let status = 'down';
  if (probe.ok) status = 'healthy';
  else if (unconfigured) status = 'unconfigured';

  const report = { ...probe, status };
  if (httpStatus != null) report.httpStatus = httpStatus;
  return report;
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'GET, OPTIONS');

  if (req.method !== 'GET') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED', 'Method not allowed'));
  }

  const [redisProbe, baserowProbe, n8nProbe] = await Promise.all([
    pingRedis(),
    pingBaserow(),
    pingN8n(),
  ]);

  const redis = classifyService(redisProbe);
  const baserow = classifyService(baserowProbe);
  const n8n = classifyService(n8nProbe);

  const services = { redis, baserow, n8n };
  const allHealthy = redis.status === 'healthy' && baserow.status === 'healthy' && n8n.status === 'healthy';
  const timestamp = new Date().toISOString();
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev';

  if (allHealthy) {
    return res.status(200).json({
      ok: true,
      status: 'healthy',
      services,
      timestamp,
      version,
    });
  }

  return res.status(503).json({
    ok: false,
    status: 'degraded',
    services,
    timestamp,
    version,
  });
}

module.exports = handler;
