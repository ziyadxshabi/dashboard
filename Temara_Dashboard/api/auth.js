/**
 * Role + username/password authentication for DentaFlow OS.
 *
 * Routes (single serverless function):
 *   POST /api/auth         → login
 *   POST /api/auth/me      → session probe
 *   POST /api/auth/logout  → clear httpOnly cookie
 *
 * Vercel env (required):
 *   JWT_SECRET
 *   DOCTOR_USERNAME, DOCTOR_PASSWORD_HASH
 *   ASSISTANT_USERNAME, ASSISTANT_PASSWORD_HASH
 *
 * Hash generator:
 *   node -e "const c=require('./api/_lib/auth-crypto');console.log(c.hashPassword('your-password'))"
 */
const {
  applyCors,
  checkLoginRateLimit,
  clearAuthCookie,
  getRoleCredentials,
  getTokenFromRequest,
  recordLoginFailure,
  resetLoginFailures,
  setAuthCookie,
  signJwt,
  verifyJwt,
  verifyPassword,
} = require('./_lib/auth-crypto');

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
  return 'login';
}

async function handleMe(req, res) {
  applyCors(res, 'POST, OPTIONS');

  const expectedRole = req.body?.expectedRole || req.headers['x-expected-role'];
  const token = getTokenFromRequest(req, expectedRole);

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const payload = verifyJwt(token, process.env.JWT_SECRET);
  if (!payload) {
    return res.status(401).json({ ok: false, error: 'Session expired' });
  }

  return res.status(200).json({
    ok: true,
    role: payload.role,
    sub: payload.sub,
  });
}

function handleLogout(req, res) {
  applyCors(res, 'POST, OPTIONS');
  clearAuthCookie(res);
  return res.status(200).json({ ok: true });
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

  const { role, username, password } = req.body ?? {};
  const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  const normalizedPassword = typeof password === 'string' ? password : '';

  if (!normalizedRole || !normalizedUsername || !normalizedPassword) {
    await recordLoginFailure();
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const creds = getRoleCredentials(normalizedRole);
  if (!creds.username || !creds.passwordHash) {
    return res.status(503).json({ ok: false, error: 'Role credentials not configured' });
  }

  const usernameMatch =
    normalizedUsername.toLowerCase() === String(creds.username).trim().toLowerCase();
  const passwordMatch = verifyPassword(normalizedPassword, creds.passwordHash);

  if (!usernameMatch || !passwordMatch) {
    await recordLoginFailure();
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  await resetLoginFailures(req);

  const token = signJwt(
    {
      role: normalizedRole,
      sub: normalizedUsername,
    },
    jwtSecret
  );

  setAuthCookie(res, token);

  return res.status(200).json({
    ok: true,
    role: normalizedRole,
    expiresInSec: 8 * 60 * 60,
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
  return handleLogin(req, res);
};
