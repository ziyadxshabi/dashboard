/**
 * Team notes proxy — JWT-gated bridge to n8n get-notes / post-note webhooks.
 * Set JWT_SECRET, N8N_WEBHOOK_GET_NOTES, N8N_WEBHOOK_POST_NOTE + N8N_AUTH_KEY in Vercel env.
 */
const { applyCors, requireBearerSession } = require('./_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 8_000;
const DEFAULT_GET_NOTES_URL =
  'https://glade-rigor-perennial.ngrok-free.dev/webhook/get-notes';
const DEFAULT_POST_NOTE_URL =
  'https://glade-rigor-perennial.ngrok-free.dev/webhook/post-note';

function upstreamHeaders(authKey, includeJson = false) {
  const headers = {
    accept: 'application/json',
    'ngrok-skip-browser-warning': 'true',
    'user-agent': 'DentaFlow-TeamNotes-Proxy/1.0',
    'x-agency-auth': authKey,
  };
  if (includeJson) headers['content-type'] = 'application/json';
  return headers;
}

module.exports = async function handler(req, res) {
  const allowedMethods = ['GET', 'POST', 'OPTIONS'];
  if (req.method === 'OPTIONS') {
    applyCors(res, allowedMethods.join(', '));
    return res.status(204).end();
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['doctor', 'assistant'] });
  if (!session) return;

  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  if (!authKey) {
    console.error('[team-notes] N8N_AUTH_KEY is not configured');
    return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
  }

  const webhookUrl = req.method === 'GET'
    ? (process.env.N8N_WEBHOOK_GET_NOTES || DEFAULT_GET_NOTES_URL)
    : (process.env.N8N_WEBHOOK_POST_NOTE || DEFAULT_POST_NOTE_URL);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const fetchOptions = {
      method: req.method,
      headers: upstreamHeaders(authKey, req.method === 'POST'),
      signal: abortController.signal,
    };

    if (req.method === 'POST') {
      fetchOptions.body = JSON.stringify(req.body ?? {});
    }

    const response = await fetch(webhookUrl, fetchOptions);
    clearTimeout(timeoutId);

    const rawText = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json';

    if (!response.ok) {
      let details = rawText?.slice(0, 500) || `HTTP ${response.status}`;
      try {
        const parsed = rawText ? JSON.parse(rawText) : null;
        if (parsed?.message) details = String(parsed.message);
      } catch { /* keep raw slice */ }
      return res.status(response.status).json({
        ok: false,
        error: 'Upstream request failed',
        details,
      });
    }

    res.setHeader('Content-Type', contentType);
    return res.status(200).send(rawText || (req.method === 'GET' ? '[]' : '{}'));
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[team-notes] Upstream fetch failed:', err);
    const isTimeout = err?.name === 'AbortError';
    return res.status(502).json({
      ok: false,
      error: isTimeout ? 'Upstream Timeout' : 'Proxy Request Failed',
      details: err?.message || 'Unknown proxy error',
    });
  }
};
