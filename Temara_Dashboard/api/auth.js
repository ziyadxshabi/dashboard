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
  withRequestLog,
} = require('./_lib/auth-crypto');
const { sanitizeString, validateRequired, createApiError } = require('./_lib/validation');

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

  req.dfAuthRole = payload.role;
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
    return res.status(503).json(
      createApiError('CONFIG_MISSING', 'Authentication service misconfigured')
    );
  }

  const rate = await checkLoginRateLimit(req);

  if (rate.blocked) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    return res.status(429).json(
      createApiError(
        'RATE_LIMIT_EXCEEDED',
        'Too many login attempts. Please try again later.',
        { retryAfter: rate.retryAfterSec }
      )
    );
  }

  const body = req.body ?? {};
  const usernameRaw = body.username ?? body.user;
  const passwordRaw = body.password ?? body.pass;
  const required = validateRequired(
    { username: usernameRaw, password: passwordRaw },
    ['username', 'password']
  );
  if (!required.valid) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', 'Username and password are required', {
        missing: required.missing,
      })
    );
  }

  const username = sanitizeString(usernameRaw, 100);
  if (!username) {
    return res.status(400).json(
      createApiError('VALIDATION_ERROR', 'Username and password are required', {
        missing: ['username'],
      })
    );
  }

  const password = typeof passwordRaw === 'string' ? passwordRaw : String(passwordRaw);
  const normalizedRole = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';

  if (!normalizedRole) {
    await recordLoginFailure();
    return res.status(401).json(createApiError('UNAUTHORIZED', 'Invalid username or password'));
  }

  const creds = getRoleCredentials(normalizedRole);
  if (!creds.username || !creds.passwordHash) {
    return res.status(503).json(
      createApiError('CONFIG_MISSING', 'Authentication service misconfigured')
    );
  }

  const usernameMatch =
    username.toLowerCase() === String(creds.username).trim().toLowerCase();

  let passwordMatch;
  try {
    passwordMatch = verifyPassword(password, creds.passwordHash);
  } catch {
    return res.status(500).json(
      createApiError('SERVER_ERROR', 'Authentication failed due to internal error')
    );
  }

  if (!usernameMatch || !passwordMatch) {
    await recordLoginFailure();
    return res.status(401).json(createApiError('UNAUTHORIZED', 'Invalid username or password'));
  }

  await resetLoginFailures(req);

  const token = signJwt(
    {
      role: normalizedRole,
      sub: username,
    },
    jwtSecret
  );

  setAuthCookie(res, token);

  req.dfAuthRole = normalizedRole;
  return res.status(200).json({
    ok: true,
    role: normalizedRole,
    username,
    expiresInSec: 8 * 60 * 60,
  });
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED', 'Method not allowed'));
  }

  const route = resolveAuthRoute(req);
  if (route === 'me') return handleMe(req, res);
  if (route === 'logout') return handleLogout(req, res);
  return handleLogin(req, res);
}

module.exports = withRequestLog(handler);
