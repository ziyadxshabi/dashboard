/**
 * Authenticated staff password update — writes staff_users.password_hash via scrypt.
 *
 * POST /api/auth/password
 * POST /api/auth?action=password  (via auth.js routing / vercel rewrite)
 *
 * Auth: httpOnly dentaflow_session cookie → JWT { sub, clinic_id }.
 */
'use strict';

const { applyCors, hashPassword, verifyPassword } = require('../_lib/auth-crypto');
const { query } = require('../_lib/db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  validatePasswordChange,
} = require('../_lib/validation');

const SELECT_PASSWORD_SQL = `
  SELECT password_hash
  FROM staff_users
  WHERE id = $1 AND clinic_id = $2
  LIMIT 1
`;

const UPDATE_PASSWORD_SQL = `
  UPDATE staff_users
  SET password_hash = $1
  WHERE id = $2 AND clinic_id = $3
`;

async function handlePasswordChange(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'POST, OPTIONS');

  if (req.method !== 'POST') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const session = requireClinicSession(req, res, { allowedRoles: ['doctor', 'assistant'] });
  if (!session) return;

  const staffId = session.sub;
  const clinicId = session.clinic_id;
  if (!staffId || !clinicId) {
    return res.status(401).json(createApiError('UNAUTHORIZED'));
  }

  const parsed = validatePasswordChange(req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  const { currentPassword, newPassword } = parsed.value;

  let row;
  try {
    const result = await query(SELECT_PASSWORD_SQL, [staffId, clinicId]);
    row = result.rows[0];
  } catch (err) {
    return sendDbError(res, err);
  }

  if (!row) {
    return res.status(401).json(createApiError('UNAUTHORIZED'));
  }

  const currentOk = verifyPassword(currentPassword, row.password_hash);
  if (!currentOk) {
    return res.status(401).json(
      createApiError('UNAUTHORIZED', 'Mot de passe actuel incorrect')
    );
  }

  let newHash;
  try {
    newHash = hashPassword(newPassword);
  } catch (err) {
    console.error('[auth/password] scrypt hash failed', err);
    return res.status(500).json(createApiError('SERVER_ERROR'));
  }

  try {
    await query(UPDATE_PASSWORD_SQL, [newHash, staffId, clinicId]);
  } catch (err) {
    return sendDbError(res, err);
  }

  return res.status(200).json({
    ok: true,
    message: 'Mot de passe mis à jour avec succès',
  });
}

module.exports = handlePasswordChange;
