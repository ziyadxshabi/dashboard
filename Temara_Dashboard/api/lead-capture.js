/**
 * Patient lead capture proxy — public POST bridge to n8n lead-capture webhook.
 * Set N8N_WEBHOOK_LEAD_CAPTURE + N8N_AUTH_KEY in Vercel env.
 */
const { applyCors, withRequestLog } = require('./_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 8_000;

function resolveLeadCaptureConfig() {
  const webhookUrl = String(
    process.env.N8N_WEBHOOK_LEAD_CAPTURE || process.env.N8N_WEBHOOK_BASE_URL || ''
  ).trim();
  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();

  if (!webhookUrl || !authKey) {
    return {
      ok: false,
      error: 'Lead capture configuration missing on server',
      code: 'CONFIG_MISSING',
    };
  }

  return { ok: true, webhookUrl, authKey };
}

function upstreamHeaders(authKey) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'DentaFlow-LeadCapture-Proxy/1.0',
    'x-agency-auth': authKey,
  };
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const body = req.body ?? {};
  const nom = typeof body.nom === 'string' ? body.nom.trim() : '';
  const telephone = typeof body.telephone === 'string' ? body.telephone.trim() : '';

  if (!nom || !telephone) {
    return res.status(400).json({ ok: false, error: 'nom and telephone are required' });
  }

  const config = resolveLeadCaptureConfig();
  if (!config.ok) {
    console.error('[lead-capture] Configuration missing');
    return res.status(503).json(config);
  }

  const { webhookUrl, authKey } = config;
  const payload = { nom, telephone };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: upstreamHeaders(authKey),
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

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
    return res.status(200).send(rawText || JSON.stringify({ ok: true, message: 'Lead captured' }));
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[lead-capture] Upstream fetch failed:', err);
    const isTimeout = err?.name === 'AbortError';
    return res.status(502).json({
      ok: false,
      error: isTimeout ? 'Upstream Timeout' : 'Proxy Request Failed',
      details: err?.message || 'Unknown proxy error',
    });
  }
}

module.exports = withRequestLog(handler);
