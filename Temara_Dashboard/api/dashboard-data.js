/**
 * Doctor dashboard data proxy — JWT-gated bridge to n8n dashboard webhook.
 * Set JWT_SECRET, N8N_WEBHOOK_DASHBOARD, and DASHBOARD_AUTH_KEY in Vercel env.
 */
const { applyCors, requireBearerSession } = require('./_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 8_000;
const DEFAULT_WEBHOOK_URL =
  'https://glade-rigor-perennial.ngrok-free.dev/webhook/dashboard-data';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['doctor'] });
  if (!session) return;

  const webhookUrl = process.env.N8N_WEBHOOK_DASHBOARD || DEFAULT_WEBHOOK_URL;
  const authKey = String(process.env.DASHBOARD_AUTH_KEY ?? process.env.N8N_AUTH_KEY ?? '').trim();
  if (!authKey) {
    console.error('[dashboard-data] DASHBOARD_AUTH_KEY is not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
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
      return res.status(500).json({ error: 'Invalid JSON response from upstream' });
    }

    if (!response.ok) {
      return res.status(500).json({
        error: 'Upstream request failed',
        details: rawText?.slice(0, 500) || `HTTP ${response.status}`,
      });
    }

    return res.status(200).json(payload);
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[dashboard-data] Upstream fetch failed:', err);
    return res.status(500).json({ error: 'n8n unreachable' });
  }
};
