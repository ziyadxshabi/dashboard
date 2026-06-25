/**
 * Assistant roster proxy — same-origin bridge to n8n webhook assistant-data.
 * Set JWT_SECRET, N8N_WEBHOOK_ROSTER + optional N8N_AUTH_KEY in Vercel env.
 */
const { applyCors, requireBearerSession } = require('./_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 8_000;
const DEFAULT_WEBHOOK_URL =
  'https://glade-rigor-perennial.ngrok-free.dev/webhook/assistant-data';

function isHtmlPayload(text, contentType) {
  const trimmed = (text ?? '').trim().toLowerCase();
  return (
    contentType.includes('text/html') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html')
  );
}

function looksLikeRosterRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return (
    Object.prototype.hasOwnProperty.call(obj, 'id') ||
    Object.prototype.hasOwnProperty.call(obj, 'Patient (Nom Complet)') ||
    Object.prototype.hasOwnProperty.call(obj, 'Date & Heure du RDV') ||
    Object.prototype.hasOwnProperty.call(obj, 'Clean_Name')
  );
}

/** Always return an array of row objects for the frontend parser. */
function normalizeUpstreamRosterRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];

  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.results)) return parsed.results;
  if (Array.isArray(parsed.items)) return parsed.items;
  if (Array.isArray(parsed.json)) return parsed.json;

  if (looksLikeRosterRecord(parsed)) return [parsed];
  if (looksLikeRosterRecord(parsed.data)) return [parsed.data];
  if (looksLikeRosterRecord(parsed.json)) return [parsed.json];

  return [];
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant'] });
  if (!session) return;

  const webhookUrl = process.env.N8N_WEBHOOK_ROSTER || DEFAULT_WEBHOOK_URL;
  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  if (!authKey) {
    console.error('[roster] N8N_AUTH_KEY is not configured');
    return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
  }

  const headers = {
    accept: 'application/json',
    'ngrok-skip-browser-warning': 'true',
    'user-agent': 'DentaFlow-Assistant-Proxy/1.0',
    'x-agency-auth': authKey,
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'GET',
      headers,
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const rawText = await response.text();

    if (!response.ok) {
      return res.status(200).json({
        ok: false,
        error: 'Upstream HTTP Error',
        details: rawText || `HTTP ${response.status}`,
        upstreamStatus: response.status,
      });
    }

    if (!rawText?.trim()) {
      return res.status(200).json({
        ok: false,
        error: 'Upstream Error',
        details: 'Réponse vide — vérifiez le nœud Respond to Webhook dans n8n.',
      });
    }

    if (isHtmlPayload(rawText, contentType)) {
      return res.status(200).json({
        ok: false,
        error: 'Upstream Error',
        details: rawText.slice(0, 500),
        ngrokInterstitial: true,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return res.status(200).json({
        ok: false,
        error: 'Upstream Error',
        details: rawText.slice(0, 500),
      });
    }

    if (parsed?.code === 404 && String(parsed?.message || '').includes('webhook')) {
      return res.status(200).json({
        ok: false,
        error: 'Webhook Not Registered',
        details: parsed.message,
        hint: parsed.hint,
      });
    }

    const rows = normalizeUpstreamRosterRows(parsed);
    return res.status(200).json({ ok: true, data: rows });
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
