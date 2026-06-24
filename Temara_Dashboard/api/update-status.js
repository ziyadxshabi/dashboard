/**
 * Roster status update proxy — POST bridge to n8n webhook update-status.
 * Set N8N_WEBHOOK_URL_UPDATE_STATUS + optional N8N_AUTH_KEY in Vercel env.
 */
const UPSTREAM_TIMEOUT_MS = 8_000;
const DEFAULT_WEBHOOK_URL =
  'https://glade-rigor-perennial.ngrok-free.dev/webhook/update-status';

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const webhookUrl = process.env.N8N_WEBHOOK_UPDATE_STATUS || DEFAULT_WEBHOOK_URL;
  const authKey = process.env.N8N_AUTH_KEY;
  const { bookingId, newStatus } = req.body ?? {};

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
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
};
