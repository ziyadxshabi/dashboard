/**
 * Doctor custom SMS blast proxy — POST bridge to n8n bulk-sms webhook.
 * Set JWT_SECRET, N8N_WEBHOOK_BULK_SMS + N8N_AUTH_KEY in Vercel env.
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');
const { sanitizeString, validatePhone, validateRequired, createApiError } = require('./_lib/validation');

const UPSTREAM_TIMEOUT_MS = 12_000;

function collectRecipientInputs(body) {
  const items = [];
  if (Array.isArray(body.recipients)) items.push(...body.recipients);
  if (Array.isArray(body.phones)) items.push(...body.phones);
  if (Array.isArray(body.targets)) items.push(...body.targets);
  if (body.phone != null) items.push(body.phone);
  if (body.patientId != null) items.push({ patientId: body.patientId, phone: body.phone });
  return items;
}

function normalizeRecipient(entry) {
  if (entry == null) return null;

  if (typeof entry === 'string' || typeof entry === 'number') {
    const raw = String(entry).trim();
    if (!raw) return null;
    const phoneCheck = validatePhone(raw);
    if (phoneCheck.valid) {
      return { phone: phoneCheck.normalized };
    }
    const id = sanitizeString(raw, 100);
    return id ? { patientId: id } : null;
  }

  if (typeof entry !== 'object') return null;

  const out = {};
  const phoneRaw = entry.phone ?? entry.telephone ?? entry.tel;
  if (phoneRaw != null) {
    const phoneCheck = validatePhone(String(phoneRaw));
    if (phoneCheck.valid) out.phone = phoneCheck.normalized;
  }

  const idRaw = entry.patientId ?? entry.id ?? entry.bookingId;
  if (idRaw != null) {
    const id = sanitizeString(String(idRaw), 100);
    if (id) out.patientId = id;
  }

  return out.phone || out.patientId ? out : null;
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED', 'Method not allowed'));
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['doctor'] });
  if (!session) return;

  const body = req.body ?? {};
  const messageRaw = body.customMessage ?? body.message ?? body.text;
  const required = validateRequired({ message: messageRaw }, ['message']);
  const customMessage = sanitizeString(messageRaw, 500);
  if (!required.valid || customMessage.length < 3) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', 'Message content is required (minimum 3 characters)', {
        field: 'message',
      })
    );
  }

  const recipientInputs = collectRecipientInputs(body);
  const hasRecipientField = (
    body.recipients != null ||
    body.phones != null ||
    body.targets != null ||
    body.phone != null ||
    body.patientId != null
  );
  const recipients = recipientInputs.map(normalizeRecipient).filter(Boolean);
  if (hasRecipientField && recipients.length === 0) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', 'At least one valid recipient is required', {
        field: 'recipients',
      })
    );
  }

  const payload = { customMessage, message: customMessage };
  if (recipients.length) {
    payload.recipients = recipients;
  }

  const webhookUrl = process.env.N8N_WEBHOOK_BULK_SMS;
  if (!webhookUrl) {
    return res.status(503).json(createApiError('CONFIG_MISSING', 'Bulk SMS webhook not configured'));
  }
  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  if (!authKey) {
    console.error('[bulk-sms] N8N_AUTH_KEY is not configured');
    return res.status(503).json(createApiError('CONFIG_MISSING', 'Server misconfiguration'));
  }

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'DentaFlow-Doctor-Proxy/1.0',
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
