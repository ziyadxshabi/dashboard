/**
 * Waitlist — Baserow Liste d'attente (table 1039940), JWT-gated.
 * N8N_WAITLIST_WEBHOOK is unused (kept in env for rollback).
 * GET is cached 20s. POST is never cached.
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');
const { cacheGet, cacheSet, cacheKey } = require('./_lib/redis');
const { sanitizeString, validatePhone, validateRequired, createApiError } = require('./_lib/validation');

const UPSTREAM_TIMEOUT_MS = 8_000;
const CACHE_TTL_SEC = 20;
const PAGE_SIZE = 200;
const ALLOWED_PRIORITIES = new Set(['Haute', 'Normale', 'Basse']);

function resolveBaserowConfig() {
  const baserowApiUrl = String(process.env.BASEROW_API_URL || '').trim().replace(/\/+$/, '');
  const tableId = String(
    process.env.BASEROW_WAITLIST_TABLE_ID || process.env.BASEROW_TABLE_ID || ''
  ).trim();
  const token = String(process.env.BASEROW_API_TOKEN || process.env.BASEROW_TOKEN || '').trim();

  if (!baserowApiUrl || !tableId || !token) {
    return {
      ok: false,
      error: 'Baserow configuration missing on server',
      code: 'CONFIG_MISSING',
    };
  }

  return { ok: true, baserowApiUrl, tableId, token };
}

function fieldVal(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v)) return v.map(fieldVal).filter(Boolean).join(' ');
    if (v.value != null) return fieldVal(v.value);
    if (v.name != null) return String(v.name);
    return '';
  }
  return v;
}

function unwrapRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && (value.value != null || value.name != null)) {
      out[key] = fieldVal(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function normalizePriority(raw) {
  const value = String(raw || '').trim();
  if (ALLOWED_PRIORITIES.has(value)) return value;
  if (/^urgent/i.test(value) || value === 'Urgence') return 'Haute';
  return 'Normale';
}

async function fetchWithTimeout(url, options) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: abortController.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWaitlistRows({ baserowApiUrl, tableId, token }) {
  const rows = [];
  let url = `${baserowApiUrl}/api/database/rows/table/${tableId}/?user_field_names=true&size=${PAGE_SIZE}`;

  while (url) {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: `Token ${token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const err = new Error(`Baserow error: ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    if (Array.isArray(data.results)) rows.push(...data.results);
    url = data.next || null;
  }

  return rows.map(unwrapRow);
}

async function createWaitlistRow({ baserowApiUrl, tableId, token }, { nom, telephone, priorite }) {
  const res = await fetchWithTimeout(
    `${baserowApiUrl}/api/database/rows/table/${tableId}/?user_field_names=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Patient: nom,
        Téléphone: telephone,
        Priorité: priorite,
      }),
    }
  );

  if (!res.ok) {
    const err = new Error(`Baserow error: ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    applyCors(res, 'GET, POST, OPTIONS');
    const session = requireBearerSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
    if (!session) return;

    const key = cacheKey('waitlist', req);
    const cached = await cacheGet(key);
    if (cached) {
      req.dfCache = 'hit';
      return res.status(200).json(cached);
    }
    req.dfCache = 'miss';

    const config = resolveBaserowConfig();
    if (!config.ok) {
      return res.status(503).json(createApiError('CONFIG_MISSING', 'Baserow configuration missing on server'));
    }

    try {
      const rows = await fetchWaitlistRows(config);
      const payload = { ok: true, data: rows };
      await cacheSet(key, payload, CACHE_TTL_SEC);
      return res.status(200).json(payload);
    } catch (err) {
      const isTimeout = err?.name === 'AbortError';
      return res.status(502).json(
        createApiError(
          'UPSTREAM_ERROR',
          'Upstream Baserow request failed',
          isTimeout ? 'Upstream Timeout' : (err?.message || 'Baserow unavailable')
        )
      );
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED', 'Method not allowed'));
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant'] });
  if (!session) return;

  const config = resolveBaserowConfig();
  if (!config.ok) {
    return res.status(503).json(createApiError('CONFIG_MISSING', 'Baserow configuration missing on server'));
  }

  const body = req.body ?? {};
  const patientNameRaw = body.patientName ?? body.name ?? body.nom;
  const phoneRaw = body.phone ?? body.telephone;
  const reasonRaw = body.reason ?? body.motif;
  const urgencyRaw = body.urgency ?? body.priority ?? body.priorite;
  const notesRaw = body.notes;

  const required = validateRequired(
    { patientName: patientNameRaw, phone: phoneRaw },
    ['patientName', 'phone']
  );
  if (!required.valid) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', 'Patient name and phone number are required', {
        missing: required.missing,
      })
    );
  }

  const patientName = sanitizeString(patientNameRaw, 100);
  if (patientName.length < 2) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', 'Patient name must be at least 2 characters', {
        field: 'patientName',
      })
    );
  }

  const phoneValidation = validatePhone(phoneRaw);
  if (!phoneValidation.valid) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', phoneValidation.error, {
        field: 'phone',
        received: phoneRaw,
      })
    );
  }

  const reason = sanitizeString(reasonRaw, 255);
  const urgency = sanitizeString(urgencyRaw, 50);
  const notes = sanitizeString(notesRaw, 1000);
  const priorite = normalizePriority(urgency || urgencyRaw);

  try {
    await createWaitlistRow(config, {
      nom: patientName,
      telephone: phoneValidation.normalized,
      priorite,
    });
    return res.status(200).json({
      ok: true,
      message: "Patient ajouté à la liste d'attente.",
    });
  } catch (err) {
    const isTimeout = err?.name === 'AbortError';
    return res.status(502).json(
      createApiError(
        'UPSTREAM_ERROR',
        'Upstream Baserow request failed',
        isTimeout ? 'Upstream Timeout' : (err?.message || 'Baserow unavailable')
      )
    );
  }
}

module.exports = withRequestLog(handler);
