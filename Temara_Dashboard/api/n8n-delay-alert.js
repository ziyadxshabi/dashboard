/**
 * Doctor delay alert proxy — POST bridge to n8n webhook doctor-delayed.
 * Set JWT_SECRET, N8N_WEBHOOK_DELAY_ALERT + optional N8N_AUTH_KEY in Vercel env.
 */
const { applyCors, requireBearerSession } = require('./_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 8_000;
const DEFAULT_WEBHOOK_URL =
  'https://glade-rigor-perennial.ngrok-free.dev/webhook/doctor-delayed';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant'] });
  if (!session) return;

  const webhookUrl = process.env.N8N_WEBHOOK_DELAY_ALERT || DEFAULT_WEBHOOK_URL;
  const authKey = process.env.N8N_AUTH_KEY;

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
    'user-agent': 'DentaFlow-Assistant-Proxy/1.0',
  };
  if (authKey) headers['x-agency-auth'] = authKey;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body ?? {}),
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    const rawText = await response.text();
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = rawText;
    }

    if (!response.ok) {
      return res.status(200).json({
        ok: false,
        error: 'Upstream HTTP Error',
        details: rawText || `HTTP ${response.status}`,
        upstreamStatus: response.status,
      });
    }

    return res.status(200).json({ ok: true, data: parsed });
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError';
    return res.status(200).json({
      ok: false,
      error: isTimeout ? 'Upstream Timeout' : 'Proxy Request Failed',
      details: err?.message || 'Unknown proxy error',
    });
  }
};
