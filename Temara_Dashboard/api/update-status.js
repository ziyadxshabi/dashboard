/**
 * Appointment status update — clinic-scoped PostgreSQL write.
 * Auth: dentaflow_session cookie → clinic_id.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  validateStatusUpdate,
} = require('./_lib/validation');

const UPDATE_STATUS_SQL = `
  UPDATE bookings
  SET status = $1
  WHERE clinic_id = $2
    AND (id::text = $3 OR cal_booking_uid = $3)
  RETURNING id, cal_booking_uid, status
`;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'POST, OPTIONS');

  if (req.method !== 'POST') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const session = requireClinicSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
  if (!session) return;

  const parsed = validateStatusUpdate(req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  try {
    const result = await query(UPDATE_STATUS_SQL, [
      parsed.value.newStatus,
      session.clinic_id,
      parsed.value.bookingId,
    ]);
    const updatedRow = result.rows[0];
    if (!updatedRow) {
      return res.status(404).json(createApiError('NOT_FOUND', 'Appointment not found'));
    }
    return res.status(200).json({ ok: true, data: updatedRow });
  } catch (err) {
    return sendDbError(res, err);
  }
};
