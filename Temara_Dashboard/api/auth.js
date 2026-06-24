/**
 * Role + username/password authentication for DentaFlow OS.
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
  getClientFingerprint,
  getLoginRateState,
  getRoleCredentials,
  recordLoginFailure,
  resetLoginFailures,
  signJwt,
  verifyPassword,
} = require('./_lib/auth-crypto');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return res.status(503).json({ ok: false, error: 'Auth not configured' });
  }

  const fingerprint = getClientFingerprint(req);
  const rate = getLoginRateState(fingerprint);

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
    recordLoginFailure(rate.entry);
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
    recordLoginFailure(rate.entry);
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  resetLoginFailures(rate.entry);

  const token = signJwt(
    {
      role: normalizedRole,
      sub: normalizedUsername,
    },
    jwtSecret
  );

  return res.status(200).json({
    ok: true,
    token,
    role: normalizedRole,
    expiresInSec: 8 * 60 * 60,
  });
};
