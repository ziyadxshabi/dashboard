/**
 * Role + PIN authentication router for DentaFlow OS.
 *
 * Routes (single serverless function):
 *   POST /api/auth         → PIN login
 *   POST /api/auth/me      → session probe
 *   POST /api/auth/logout  → clear httpOnly cookie
 *
 * Set DOCTOR_PIN and ASSISTANT_PIN in Vercel env.
 */
const {
  applyCors,
  clearAuthCookie,
  getTokenFromRequest,
  setAuthCookie,
  signJwt,
  verifyJwt,
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
  applyCors(res, 'POST, OPTIONS');

  const { role, pin } = req.body ?? {};
  const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
  const normalizedPin = typeof pin === 'string' ? pin.trim() : '';

  if (!normalizedRole || !normalizedPin) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const expectedPin =
    normalizedRole === 'doctor'
      ? process.env.DOCTOR_PIN
      : normalizedRole === 'assistant'
        ? process.env.ASSISTANT_PIN
        : null;

  if (!expectedPin || normalizedPin !== expectedPin) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return res.status(503).json({ ok: false, error: 'Auth not configured' });
  }

  const token = signJwt(
    {
      role: normalizedRole,
      sub: normalizedRole,
    },
    jwtSecret
  );

  setAuthCookie(res, token, 'dentaflow_session_ast');

  return res.status(200).json({ ok: true, role: normalizedRole });
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
