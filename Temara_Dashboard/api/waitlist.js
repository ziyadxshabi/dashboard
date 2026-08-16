/**
 * Waitlist — Baserow Liste d'attente (table 1039940), JWT-gated.
 * N8N_WAITLIST_WEBHOOK is unused (kept in env for rollback).
 * GET is cached 20s. POST is never cached.
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');
const { cacheGet, cacheSet, cacheKey } = require('./_lib/redis');

const BASE_API = 'https://api.baserow.io';
const DEFAULT_TABLE_ID = '1039940';
const UPSTREAM_TIMEOUT_MS = 8_000;
const CACHE_TTL_SEC = 20;
const PAGE_SIZE = 200;
const PHONE_RE = /^(\+212\s?|0)[5-7]\d{8}$/;
const ALLOWED_PRIORITIES = new Set(['Haute', 'Normale', 'Basse']);

function waitlistTableId() {
  return String(process.env.BASEROW_WAITLIST_TABLE_ID || DEFAULT_TABLE_ID).trim() || DEFAULT_TABLE_ID;
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

function compactPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/[\s.\-]/g, '');
  if (compact.indexOf('+212') === 0) {
    return `+212${compact.slice(4)}`;
  }
  return compact;
}

function isValidMoroccanPhone(value) {
  return PHONE_RE.test(compactPhone(value));
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

async function fetchWaitlistRows(token) {
  const tableId = waitlistTableId();
  const rows = [];
  let url = `${BASE_API}/api/database/rows/table/${tableId}/?user_field_names=true&size=${PAGE_SIZE}`;

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

async function createWaitlistRow(token, { nom, telephone, priorite }) {
  const tableId = waitlistTableId();
  const res = await fetchWithTimeout(
    `${BASE_API}/api/database/rows/table/${tableId}/?user_field_names=true`,
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

    const token = String(process.env.BASEROW_API_TOKEN || '').trim();
    if (!token) {
      return res.status(503).json({
        ok: false,
        error: 'Baserow API token not configured',
        code: 'SERVER_ERROR',
      });
    }

    try {
      const rows = await fetchWaitlistRows(token);
      const payload = { ok: true, data: rows };
      await cacheSet(key, payload, CACHE_TTL_SEC);
      return res.status(200).json(payload);
    } catch (err) {
      const isTimeout = err?.name === 'AbortError';
      return res.status(503).json({
        ok: false,
        error: isTimeout ? 'Upstream Timeout' : (err?.message || 'Baserow unavailable'),
        code: 'SERVER_ERROR',
      });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant'] });
  if (!session) return;

  const token = String(process.env.BASEROW_API_TOKEN || '').trim();
  if (!token) {
    return res.status(503).json({
      ok: false,
      error: 'Baserow API token not configured',
      code: 'SERVER_ERROR',
    });
  }

  const body = req.body ?? {};
  const nom = String(body.nom ?? body.name ?? '').trim();
  const telephone = String(body.telephone ?? body.phone ?? '').trim();
  const priorite = normalizePriority(body.priorite ?? body.priority);

  if (nom.length < 2) {
    return res.status(400).json({ ok: false, error: 'nom and telephone are required' });
  }
  if (!isValidMoroccanPhone(telephone)) {
    return res.status(400).json({ ok: false, error: 'nom and telephone are required' });
  }

  try {
    await createWaitlistRow(token, { nom, telephone, priorite });
    return res.status(200).json({
      ok: true,
      message: "Patient ajouté à la liste d'attente.",
    });
  } catch (err) {
    const isTimeout = err?.name === 'AbortError';
    return res.status(503).json({
      ok: false,
      error: isTimeout ? 'Upstream Timeout' : (err?.message || 'Baserow unavailable'),
      code: 'SERVER_ERROR',
    });
  }
}

module.exports = withRequestLog(handler);
