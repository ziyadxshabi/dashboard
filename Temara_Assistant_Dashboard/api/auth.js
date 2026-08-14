/**
 * Role + PIN authentication router for DentaFlow OS.
 * Set DOCTOR_PIN and ASSISTANT_PIN in Vercel env.
 */
const { setAuthCookie, signJwt } = require('./_lib/auth-crypto');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

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

  setAuthCookie(res, token);

  return res.status(200).json({ ok: true, role: normalizedRole });
};
