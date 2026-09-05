/**
 * DentaFlow OS — staff_users login against PostgreSQL.
 *
 * Routes (single serverless function, plus rewrite fallbacks):
 *   POST /api/auth            → login
 *   POST /api/auth/me         → session probe (also Temara_Dashboard/api/auth/me.js)
 *   POST /api/auth/logout     → clear httpOnly cookie
 *   POST /api/auth/password   → update staff_users.password_hash (also api/auth/password.js)
 *
 * JWT is stored in a single httpOnly cookie: dentaflow_session.
 */
'use strict';

const {
  applyCors,
  checkLoginRateLimit,
  clearAuthCookie,
  getTokenFromRequest,
  recordLoginFailure,
  resetLoginFailures,
  setAuthCookie,
  signJwt,
  verifyJwt,
  verifyPassword,
} = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const handlePasswordChange = require('./auth/password');

const DEFAULT_CLINIC_SLUG = 'temara';

const STAFF_NAME_ALIASES = {
  doctor: ['doctor', 'docteur'],
  docteur: ['doctor', 'docteur'],
  assistant: ['assistant', 'assistante'],
  assistante: ['assistant', 'assistante'],
};

const STAFF_ROLE_ALIASES = {
  doctor: 'doctor',
  docteur: 'doctor',
  assistant: 'assistant',
  assistante: 'assistant',
};

const STAFF_LOOKUP_SQL = `
  SELECT
    su.id,
    su.clinic_id,
    su.username,
    su.password_hash,
    su.role::text AS role,
    su.display_name,
    c.slug,
    c.name AS clinic_name
  FROM staff_users su
  INNER JOIN clinics c ON c.id = su.clinic_id
  WHERE lower(su.username) = ANY($1::text[])
    AND c.slug = $2
  LIMIT 1
`;

function staffLookupNames(username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return [];
  const aliases = STAFF_NAME_ALIASES[key];
  return aliases ? [...aliases] : [key];
}

function canonicalizeStaffRole(role) {
  const key = String(role || '').trim().toLowerCase();
  if (!key) return '';
  return STAFF_ROLE_ALIASES[key] || key;
}

function resolveAuthRoute(req) {
  const raw = String(req.url || '');
  let pathname = raw.split('?')[0];
  let action = '';
  try {
    const parsed = new URL(raw, 'http://localhost');
    pathname = parsed.pathname;
    action = parsed.searchParams.get('action') || '';
  } catch { /* use raw path */ }

  const headerPath = String(
    req.headers['x-invoke-path'] ||
    req.headers['x-matched-path'] ||
    req.headers['x-vercel-original-path'] ||
    ''
  );
  const combined = `${pathname} ${headerPath} ${raw} ${action}`.toLowerCase();

  if (combined.includes('/me') || action === 'me') return 'me';
  if (combined.includes('/logout') || action === 'logout') return 'logout';
  if (combined.includes('/password') || action === 'password') return 'password';
  return 'login';
}

function sessionUserFromPayload(payload) {
  return {
    sub: payload.sub,
    role: payload.role,
    clinic_id: payload.clinic_id,
    slug: payload.slug,
  };
}

async function handleMe(req, res) {
  applyCors(res, 'POST, OPTIONS');

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(503).json({ ok: false, code: 'UNAUTHORIZED' });
  }

  const token = getTokenFromRequest(req);
  const payload = verifyJwt(token, secret);
  if (!payload?.sub || !payload?.role || !payload?.clinic_id) {
    return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
  }

  return res.status(200).json({
    ok: true,
    authenticated: true,
    user: sessionUserFromPayload(payload),
    role: payload.role,
    sub: payload.sub,
  });
}

function handleLogout(req, res) {
  applyCors(res, 'POST, OPTIONS');
  clearAuthCookie(res);
  return res.status(200).json({ ok: true });
}

function resolveClinicSlug(body) {
  const raw = body?.slug ?? body?.clinicSlug ?? body?.clinic_slug ?? body?.clinic;
  const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return slug || DEFAULT_CLINIC_SLUG;
}

async function handleLogin(req, res) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return res.status(503).json({ ok: false, error: 'Auth not configured' });
  }

  const rate = await checkLoginRateLimit(req);

  if (rate.blocked) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    return res.status(429).json({
      ok: false,
      error: 'Too Many Requests',
      message: 'Trop de tentatives. Réessayez dans quelques minutes.',
      retryAfterSec: rate.retryAfterSec,
    });
  }

  const body = req.body ?? {};
  const requestedRole = canonicalizeStaffRole(
    typeof body.role === 'string' ? body.role.trim() : ''
  );
  const normalizedUsername = typeof body.username === 'string' ? body.username.trim() : '';
  const normalizedPassword = typeof body.password === 'string' ? body.password : '';
  const clinicSlug = resolveClinicSlug(body);
  const lookupNames = staffLookupNames(normalizedUsername);

  if (!normalizedUsername || !normalizedPassword) {
    await recordLoginFailure();
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  let staffRow;
  try {
    const result = await query(STAFF_LOOKUP_SQL, [lookupNames, clinicSlug]);
    staffRow = result.rows[0];
  } catch (err) {
    console.error('[auth] staff_users lookup failed:', err?.message || err);
    return res.status(503).json({ ok: false, error: 'Auth not configured' });
  }

  if (!staffRow) {
    await recordLoginFailure();
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (requestedRole && requestedRole !== staffRow.role) {
    await recordLoginFailure();
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const passwordMatch = verifyPassword(normalizedPassword, staffRow.password_hash);
  if (!passwordMatch) {
    await recordLoginFailure();
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  await resetLoginFailures(req);

  const token = signJwt(
    {
      sub: staffRow.id,
      role: staffRow.role,
      clinic_id: staffRow.clinic_id,
      slug: staffRow.slug,
    },
    jwtSecret
  );

  setAuthCookie(res, token);

  return res.status(200).json({
    ok: true,
    user: {
      username: staffRow.username,
      role: staffRow.role,
      displayName: staffRow.display_name,
      clinicSlug: staffRow.slug,
      clinicName: staffRow.clinic_name,
    },
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const route = resolveAuthRoute(req);
  if (route === 'me') return handleMe(req, res);
  if (route === 'logout') return handleLogout(req, res);
  if (route === 'password') return handlePasswordChange(req, res);
  return handleLogin(req, res);
};
