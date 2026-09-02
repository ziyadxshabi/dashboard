/**
 * Doctor delay alert proxy — POST bridge to n8n webhook doctor-delayed.
 * Set N8N_WEBHOOK_URL_DELAY_ALERT + optional N8N_AUTH_KEY in Vercel env.
 */
const { withRequestLog } = require('./_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 8_000;

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const webhookUrl = process.env.N8N_WEBHOOK_DELAY_ALERT;
  if (!webhookUrl) {
    return res.status(503).json({ ok: false, error: 'Webhook not configured' });
  }
  const authKey = process.env.N8N_AUTH_KEY;

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
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
}

module.exports = withRequestLog(handler);
