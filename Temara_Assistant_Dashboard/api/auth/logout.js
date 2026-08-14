/**
 * Logout — clears the httpOnly session cookie.
 */
const { applyCors, clearAuthCookie } = require('../_lib/auth-crypto');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  applyCors(res, 'POST, OPTIONS');
  clearAuthCookie(res);
  return res.status(200).json({ ok: true });
};
