/**
 * Universal n8n webhook proxy for miscellaneous POST targets.
 * Set the N8N_WEBHOOK_* env vars below + N8N_AUTH_KEY in Vercel.
 */
const { applyCors, requireBearerSession } = require('../_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 30_000;

const TARGET_ENV = {
  'daily-report-export': 'N8N_WEBHOOK_DAILY_REPORT_EXPORT',
  'force-reminders': 'N8N_WEBHOOK_FORCE_REMINDERS',
  'bulk-confirm': 'N8N_WEBHOOK_BULK_CONFIRM',
  'bulk-cancel': 'N8N_WEBHOOK_BULK_CANCEL',
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'POST, OPTIONS');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
  if (!session) return;

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? { ...req.body }
    : {};

  const target = String(body.target ?? '').trim();
  if (!target) {
    return res.status(400).json({ ok: false, error: 'target is required' });
  }

  const envKey = TARGET_ENV[target];
  if (!envKey) {
    return res.status(400).json({ ok: false, error: 'Unknown target' });
  }

  const webhookUrl = String(process.env[envKey] ?? '').trim();
  if (!webhookUrl) {
    return res.status(503).json({ ok: false, error: 'Server configuration missing' });
  }

  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  delete body.target;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const headers = {
      accept: '*/*',
      'content-type': 'application/json',
      'user-agent': 'DentaFlow-Misc-Proxy/1.0',
    };
    if (authKey) {
      headers['x-agency-auth'] = authKey;
    }

    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) {
      res.setHeader('Content-Disposition', disposition);
    }
    return res.send(buffer);
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError';
    return res.status(502).json({
      ok: false,
      error: isTimeout ? 'Upstream Timeout' : 'Proxy Request Failed',
      details: err?.message || 'Unknown proxy error',
    });
  }
};
