/**
 * Public clinic metadata — tenant-aware booking portal (no JWT).
 * Filesystem route: GET /api/public/clinic/:slug
 * Never returns secrets, Twilio numbers, or internal UUIDs.
 */
'use strict';

const { applyCors } = require('../../_lib/auth-crypto');
const { query } = require('../../_lib/db');
const { createApiError, sendDbError } = require('../../_lib/validation');

const DEFAULT_SLUG = 'temara';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CLINIC_PUBLIC_SQL = `
  SELECT id, slug, name, phone, theme_preset, theme_tokens, cal_event_type_id, sms_booking_url
  FROM clinics
  WHERE slug = $1
  LIMIT 1
`;

function sanitizeSlug(raw) {
  const slug = String(raw ?? '').trim().toLowerCase();
  if (!slug) return DEFAULT_SLUG;
  if (!SLUG_RE.test(slug) || slug.length > 64) return null;
  return slug;
}

function extractSlug(req) {
  const fromQuery = req.query && req.query.slug;
  if (fromQuery != null && String(fromQuery).trim() !== '') {
    return sanitizeSlug(fromQuery);
  }

  const path = String(req.url || '').split('?')[0];
  const match = path.match(/\/clinic\/([^/]+)\/?$/);
  if (match) {
    try {
      return sanitizeSlug(decodeURIComponent(match[1]));
    } catch {
      return null;
    }
  }

  return DEFAULT_SLUG;
}

function parseThemeTokens(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

function resolveCalEmbedUrl(row) {
  const smsUrl = String(row.sms_booking_url || '').trim();
  if (/^https:\/\//i.test(smsUrl)) return smsUrl;

  const eventType = String(row.cal_event_type_id || '').trim().replace(/^\/+/, '');
  if (!eventType) return '';
  if (/^https:\/\//i.test(eventType)) return eventType;
  return `https://cal.com/${eventType}`;
}

function toPublicClinic(row) {
  const themeTokens = parseThemeTokens(row.theme_tokens);
  const calEventTypeId = String(row.cal_event_type_id || '');
  const calEmbedUrl = resolveCalEmbedUrl(row);
  return {
    name: String(row.name || ''),
    slug: String(row.slug || ''),
    phone: String(row.phone || ''),
    themePreset: String(row.theme_preset || 'oak-lounge'),
    theme_preset: String(row.theme_preset || 'oak-lounge'),
    themeTokens,
    theme_tokens: themeTokens,
    calEventTypeId,
    cal_event_type_id: calEventTypeId,
    calEmbedUrl,
    cal_embed_url: calEmbedUrl,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'GET, OPTIONS');

  if (req.method !== 'GET') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const slug = extractSlug(req);
  if (!slug) {
    return res.status(404).json(createApiError('NOT_FOUND', 'Clinic not found'));
  }

  try {
    const result = await query(CLINIC_PUBLIC_SQL, [slug]);
    const row = result.rows && result.rows[0];
    if (!row) {
      return res.status(404).json(createApiError('NOT_FOUND', 'Clinic not found'));
    }

    return res.status(200).json({
      ok: true,
      clinic: toPublicClinic(row),
    });
  } catch (err) {
    return sendDbError(res, err);
  }
};
