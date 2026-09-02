/**
 * Roster — Baserow Bookings (table 1017856), JWT-gated.
 * N8N_WEBHOOK_ROSTER is unused (kept in env for rollback).
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');
const { cacheGet, cacheSet, cacheKey } = require('./_lib/redis');
const { createApiError } = require('./_lib/validation');

const UPSTREAM_TIMEOUT_MS = 8_000;
const CACHE_TTL_SEC = 30;
const PAGE_SIZE = 200;

function resolveBaserowConfig() {
  const baserowApiUrl = String(process.env.BASEROW_API_URL || '').trim().replace(/\/+$/, '');
  const tableId = String(process.env.BASEROW_TABLE_ID || '').trim();
  const token = String(process.env.BASEROW_API_TOKEN || process.env.BASEROW_TOKEN || '').trim();

  if (!baserowApiUrl || !tableId || !token) {
    return createApiError('CONFIG_MISSING', 'Baserow configuration missing on server');
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

function casablancaYmd(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
}

function rowDateKey(dateVal) {
  const dateStr = String(fieldVal(dateVal) || '');
  if (!dateStr) return '';
  if (dateStr.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    const parsed = new Date(dateStr);
    if (!Number.isNaN(parsed.getTime())) return casablancaYmd(parsed);
    return dateStr.slice(0, 10);
  }
  const parts = dateStr.split(' ')[0].split('/');
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year = parts[2];
    return `${year}-${month}-${day}`;
  }
  return '';
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

async function fetchBaserowRows({ baserowApiUrl, tableId, token }) {
  const rows = [];
  let url = `${baserowApiUrl}/api/database/rows/table/${tableId}/?user_field_names=true&size=${PAGE_SIZE}`;

  while (url) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Token ${token}`,
          Accept: 'application/json',
        },
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const rawText = await res.text();

    if (!res.ok) {
      const err = new Error('Upstream Baserow request failed');
      err.apiError = createApiError('UPSTREAM_ERROR', 'Upstream Baserow request failed', {
        status: res.status,
        text: rawText?.slice(0, 500) || `HTTP ${res.status}`,
      });
      throw err;
    }

    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      const err = new Error('Invalid JSON received from Baserow');
      err.apiError = createApiError('UPSTREAM_ERROR', 'Invalid JSON received from Baserow', {
        preview: rawText.slice(0, 200),
      });
      throw err;
    }

    if (Array.isArray(data.results)) rows.push(...data.results);
    url = data.next || null;
  }

  return rows;
}

async function fetchTodayAppointments() {
  const config = resolveBaserowConfig();
  if (!config.ok) {
    return config;
  }

  const { baserowApiUrl, tableId, token } = config;

  try {
    const allRows = await fetchBaserowRows({ baserowApiUrl, tableId, token });
    const todayStr = casablancaYmd();
    const todayAppts = allRows
      .filter((row) => rowDateKey(row['Date & Heure du RDV'] || row.Date || row.date) === todayStr)
      .map(unwrapRow);

    return { ok: true, data: todayAppts };
  } catch (err) {
    if (err?.apiError) return err.apiError;
    return createApiError('UPSTREAM_ERROR', 'Upstream Baserow fetch failed or timed out', {
      message: err?.message || 'Unknown proxy error',
    });
  }
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED', 'Method not allowed'));
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
  if (!session) return;

  const rosterCacheKey = cacheKey('roster', req);
  const cached = await cacheGet(rosterCacheKey);
  if (cached) {
    req.dfCache = 'hit';
    return res.status(200).json(cached);
  }
  req.dfCache = 'miss';

  const payload = await fetchTodayAppointments();
  if (!payload.ok) {
    const status = payload.code === 'CONFIG_MISSING' ? 503 : 502;
    return res.status(status).json(payload);
  }

  await cacheSet(rosterCacheKey, payload, CACHE_TTL_SEC);
  return res.status(200).json(payload);
}

module.exports = withRequestLog(handler);
