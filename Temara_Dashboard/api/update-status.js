/**
 * Roster status update proxy — POST bridge to n8n webhook update-status.
 * Set JWT_SECRET, N8N_WEBHOOK_UPDATE_STATUS + optional N8N_AUTH_KEY in Vercel env.
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 8_000;

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res);
  if (!session) return;

  if (!['assistant', 'doctor'].includes(session.role)) {
    return res.status(403).json({ error: 'Accès refusé: Rôle non autorisé.' });
  }

  const webhookUrl = process.env.N8N_WEBHOOK_UPDATE_STATUS;
  if (!webhookUrl) {
    return res.status(503).json({ ok: false, error: 'Webhook not configured' });
  }
  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  if (!authKey) {
    console.error('[update-status] N8N_AUTH_KEY is not configured');
    return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
  }
  const { bookingId, newStatus } = req.body ?? {};

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'DentaFlow-Assistant-Proxy/1.0',
    'x-agency-auth': authKey,
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bookingId, newStatus }),
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
      return res.status(response.status).json({
        ok: false,
        error: 'Upstream HTTP Error',
        details: rawText || `HTTP ${response.status}`,
      });
    }

    return res.status(200).json({ ok: true, data: parsed });
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError';
    return res.status(502).json({
      ok: false,
      error: isTimeout ? 'Upstream Timeout' : 'Proxy Request Failed',
      details: err?.message || 'Unknown proxy error',
    });
  }
}

module.exports = withRequestLog(handler);
