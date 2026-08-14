/**
 * Session probe — reads JWT from httpOnly cookie (Bearer fallback).
 */
const {
  applyCors,
  getTokenFromRequest,
  verifyJwt,
} = require('../_lib/auth-crypto');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  applyCors(res, 'POST, OPTIONS');

  const token = getTokenFromRequest(req);
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
};
