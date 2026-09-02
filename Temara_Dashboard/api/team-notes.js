/**
 * Team notes proxy — JWT-gated bridge to n8n get-notes / post-note webhooks.
 * Set JWT_SECRET, N8N_WEBHOOK_GET_NOTES, N8N_WEBHOOK_POST_NOTE + N8N_AUTH_KEY in Vercel env.
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');
const { sanitizeString, validateRequired, createApiError } = require('./_lib/validation');

const UPSTREAM_TIMEOUT_MS = 8_000;

function upstreamHeaders(authKey, includeJson = false) {
  const headers = {
    accept: 'application/json',
    'user-agent': 'DentaFlow-TeamNotes-Proxy/1.0',
    'x-agency-auth': authKey,
  };
  if (includeJson) headers['content-type'] = 'application/json';
  return headers;
}

async function handler(req, res) {
  const allowedMethods = ['GET', 'POST', 'OPTIONS'];
  if (req.method === 'OPTIONS') {
    applyCors(res, allowedMethods.join(', '));
    return res.status(204).end();
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED', 'Method not allowed'));
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['doctor', 'assistant'] });
  if (!session) return;

  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  if (!authKey) {
    console.error('[team-notes] N8N_AUTH_KEY is not configured');
    return res.status(503).json(createApiError('CONFIG_MISSING', 'Server misconfiguration'));
  }

  const webhookUrl = req.method === 'GET'
    ? process.env.N8N_WEBHOOK_GET_NOTES
    : process.env.N8N_WEBHOOK_POST_NOTE;
  if (!webhookUrl) {
    return res.status(503).json(createApiError('CONFIG_MISSING', 'Team notes webhook not configured'));
  }

  let postPayload = null;
  if (req.method === 'POST') {
    const body = req.body ?? {};
    const noteRaw = body.note ?? body.text ?? body.content;
    const required = validateRequired({ note: noteRaw }, ['note']);
    const note = sanitizeString(noteRaw, 2000);
    if (!required.valid || !note) {
      return res.status(400).json(
        createApiError('VALIDATION_ERROR', 'Note content is required and cannot be empty', {
          field: 'note',
        })
      );
    }

    postPayload = {
      note,
      text: note,
    };

    const linkedId = sanitizeString(String(body.patientId ?? body.bookingId ?? ''), 100);
    if (linkedId) {
      if (body.patientId != null) postPayload.patientId = linkedId;
      if (body.bookingId != null) postPayload.bookingId = linkedId;
      if (body.patientId == null && body.bookingId == null) postPayload.patientId = linkedId;
    }

    if (body.author != null) {
      postPayload.author = sanitizeString(body.author, 100);
    }
    if (body.category != null) {
      postPayload.category = sanitizeString(String(body.category), 100);
    }
    if (body.time != null) {
      postPayload.time = sanitizeString(String(body.time), 50);
    }
    if (body.pinned != null) {
      postPayload.pinned = Boolean(body.pinned);
    }
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const fetchOptions = {
      method: req.method,
      headers: upstreamHeaders(authKey, req.method === 'POST'),
      signal: abortController.signal,
    };

    if (req.method === 'POST') {
      fetchOptions.body = JSON.stringify(postPayload);
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
      return res.status(502).json(
        createApiError('UPSTREAM_ERROR', 'Upstream request failed', details)
      );
    }

    res.setHeader('Content-Type', contentType);
    return res.status(200).send(rawText || (req.method === 'GET' ? '[]' : '{}'));
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[team-notes] Upstream fetch failed:', err);
    const isTimeout = err?.name === 'AbortError';
    return res.status(502).json(
      createApiError(
        'UPSTREAM_ERROR',
        isTimeout ? 'Upstream Timeout' : 'Proxy Request Failed',
        err?.message || 'Unknown proxy error'
      )
    );
  }
}

module.exports = withRequestLog(handler);
