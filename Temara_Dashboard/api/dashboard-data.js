/**
 * Doctor dashboard data proxy — JWT-gated bridge to n8n dashboard webhook.
 * Set JWT_SECRET, N8N_WEBHOOK_DASHBOARD, and DASHBOARD_AUTH_KEY in Vercel env.
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');
const { cacheGet, cacheSet, cacheKey } = require('./_lib/redis');
const { createApiError } = require('./_lib/validation');

const UPSTREAM_TIMEOUT_MS = 8_000;

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED', 'Method not allowed'));
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['doctor'] });
  if (!session) return;

  const dashKey = cacheKey('dash', req);
  const cached = await cacheGet(dashKey);
  if (cached) {
    req.dfCache = 'hit';
    return res.status(200).json(cached);
  }
  req.dfCache = 'miss';

  const webhookUrl = process.env.N8N_WEBHOOK_DASHBOARD;
  if (!webhookUrl) {
    return res.status(503).json(
      createApiError('CONFIG_MISSING', 'Dashboard webhook or server auth not configured')
    );
  }
  const authKey = String(process.env.DASHBOARD_AUTH_KEY ?? process.env.N8N_AUTH_KEY ?? '').trim();
  if (!authKey) {
    console.error('[dashboard-data] DASHBOARD_AUTH_KEY is not configured');
    return res.status(503).json(
      createApiError('CONFIG_MISSING', 'Dashboard webhook or server auth not configured')
    );
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'DentaFlow-Doctor-Proxy/1.0',
        'x-agency-auth': authKey,
      },
      signal: abortController.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    const rawText = await response.text();
    let payload;

    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      return res.status(502).json(
        createApiError('UPSTREAM_ERROR', 'Invalid JSON received from upstream webhook', {
          preview: rawText.slice(0, 200),
        })
      );
    }

    if (!response.ok) {
      return res.status(502).json(
        createApiError('UPSTREAM_ERROR', 'Upstream dashboard webhook error', {
          status: response.status,
          text: rawText?.slice(0, 500) || `HTTP ${response.status}`,
        })
      );
    }

    await cacheSet(dashKey, payload, 30);
    return res.status(200).json(payload);
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[dashboard-data] Upstream fetch failed:', err);
    return res.status(502).json(
      createApiError('UPSTREAM_ERROR', 'Dashboard upstream request failed or timed out', {
        message: err?.message || 'Unknown proxy error',
      })
    );
  }
}

module.exports = withRequestLog(handler);
