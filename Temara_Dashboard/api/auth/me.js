/**
 * Session probe — reads httpOnly dentaflow_session and returns JWT claims.
 */
'use strict';

const { applyCors, getTokenFromRequest, verifyJwt } = require('../_lib/auth-crypto');

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

  return res.status(200).json({
    ok: true,
    authenticated: true,
    user: {
      sub: payload.sub,
      role: payload.role,
      clinic_id: payload.clinic_id,
      slug: payload.slug,
    },
  });
};
