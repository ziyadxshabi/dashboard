/**
 * Session probe — reads httpOnly dentaflow_session and returns verified staff + clinic branding.
 */
'use strict';

const { applyCors, getTokenFromRequest, verifyJwt } = require('../_lib/auth-crypto');
const { query } = require('../_lib/db');

const SESSION_HYDRATE_SQL = `
  SELECT
    su.id,
    su.clinic_id,
    su.role::text AS role,
    su.display_name,
    c.slug,
    c.name AS clinic_name,
    c.theme_preset,
    c.theme_tokens
  FROM staff_users su
  INNER JOIN clinics c ON c.id = su.clinic_id
  WHERE su.id = $1
    AND su.clinic_id = $2
  LIMIT 1
`;

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

function toVerifiedUser(row, payload) {
  const slug = String(row?.slug || payload?.slug || '');
  return {
    sub: row?.id || payload?.sub,
    role: String(row?.role || payload?.role || ''),
    clinic_id: row?.clinic_id || payload?.clinic_id,
    slug,
    displayName: String(row?.display_name || '').trim(),
    clinicName: String(row?.clinic_name || '').trim(),
    clinicSlug: slug,
    themePreset: String(row?.theme_preset || '').trim(),
    themeTokens: parseThemeTokens(row?.theme_tokens),
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'GET, POST, OPTIONS');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, code: 'UNAUTHORIZED' });
  }

  const secret = process.env.JWT_SECRET;
  const token = getTokenFromRequest(req);
  const payload = secret ? verifyJwt(token, secret) : null;

  if (!payload?.sub || !payload?.role || !payload?.clinic_id) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
  }

  let row = null;
  try {
    const result = await query(SESSION_HYDRATE_SQL, [payload.sub, payload.clinic_id]);
    row = result.rows[0] || null;
  } catch (err) {
    console.error('[auth/me] session hydrate failed:', err?.message || err);
  }

  const user = toVerifiedUser(row, payload);
  return res.status(200).json({
    ok: true,
    authenticated: true,
    user,
    role: user.role,
    sub: user.sub,
  });
};
