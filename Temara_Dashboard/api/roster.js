/**
 * Roster — Baserow Bookings (table 1017856), JWT-gated.
 * N8N_WEBHOOK_ROSTER is unused (kept in env for rollback).
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');
const { cacheGet, cacheSet, cacheKey } = require('./_lib/redis');

const BASE_API = 'https://api.baserow.io';
const TABLE_ID = '1017856';
const UPSTREAM_TIMEOUT_MS = 8_000;
const CACHE_TTL_SEC = 30;
const PAGE_SIZE = 200;

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

async function fetchBaserowRows(token) {
  const rows = [];
  let url = `${BASE_API}/api/database/rows/table/${TABLE_ID}/?user_field_names=true&size=${PAGE_SIZE}`;

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

    if (!res.ok) {
      const err = new Error(`Baserow error: ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    if (Array.isArray(data.results)) rows.push(...data.results);
    url = data.next || null;
  }

  return rows;
}

async function fetchTodayAppointments() {
  const token = String(process.env.BASEROW_API_TOKEN || '').trim();
  if (!token) {
    return { ok: false, error: 'Baserow API token not configured', code: 'SERVER_ERROR' };
  }

  try {
    const allRows = await fetchBaserowRows(token);
    const todayStr = casablancaYmd();
    const todayAppts = allRows
      .filter((row) => rowDateKey(row['Date & Heure du RDV'] || row.Date || row.date) === todayStr)
      .map(unwrapRow);

    return { ok: true, data: todayAppts };
  } catch (err) {
    const isTimeout = err?.name === 'AbortError';
    return {
      ok: false,
      error: isTimeout ? 'Upstream Timeout' : (err?.message || 'Baserow unavailable'),
      code: 'SERVER_ERROR',
    };
  }
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
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
    return res.status(503).json(payload);
  }

  await cacheSet(rosterCacheKey, payload, CACHE_TTL_SEC);
  return res.status(200).json(payload);
}

module.exports = withRequestLog(handler);
