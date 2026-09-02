/**
 * Fill-gap / waitlist blast proxy — POST bridge to n8n webhook fill-gap.
 * Set JWT_SECRET, N8N_WEBHOOK_FILL_GAP + N8N_AUTH_KEY in Vercel env.
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');
const { sanitizeString, validateDate, validateTime, validateRequired, createApiError } = require('./_lib/validation');

const UPSTREAM_TIMEOUT_MS = 8_000;

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED', 'Method not allowed'));
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant'] });
  if (!session) return;

  const webhookUrl = process.env.N8N_WEBHOOK_FILL_GAP;
  if (!webhookUrl) {
    return res.status(503).json(createApiError('CONFIG_MISSING', 'Webhook not configured'));
  }
  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  if (!authKey) {
    console.error('[fill-gap] N8N_AUTH_KEY is not configured');
    return res.status(503).json(createApiError('CONFIG_MISSING', 'Server misconfiguration'));
  }

  const body = req.body ?? {};
  const slotDate = body.slotDate ?? body.date;
  const slotTime = body.slotTime ?? body.time;
  const reason = body.reason;
  const patientId = body.patientId;

  const required = validateRequired({ slotDate, slotTime }, ['slotDate', 'slotTime']);
  if (!required.valid) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', 'Missing required slot date or time', {
        missing: required.missing,
      })
    );
  }

  const dateValidation = validateDate(slotDate);
  if (!dateValidation.valid) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', 'Invalid slot date format (expected YYYY-MM-DD)', {
        field: 'slotDate',
        received: slotDate,
      })
    );
  }

  const timeValidation = validateTime(slotTime);
  if (!timeValidation.valid) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', 'Invalid slot time format (expected HH:MM)', {
        field: 'slotTime',
        received: slotTime,
      })
    );
  }

  const payload = {
    slotDate: dateValidation.formatted,
    slotTime: timeValidation.formatted,
    reason: sanitizeString(reason, 500),
  };
  if (patientId != null && String(patientId).trim()) {
    payload.patientId = sanitizeString(String(patientId), 100);
  }

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'DentaFlow-Assistant-Proxy/1.0',
    'x-agency-auth': authKey,
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
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
      return res.status(502).json(
        createApiError('UPSTREAM_ERROR', 'Upstream HTTP Error', rawText || `HTTP ${response.status}`)
      );
    }

    return res.status(200).json({ ok: true, data: parsed });
  } catch (err) {
    clearTimeout(timeoutId);
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
