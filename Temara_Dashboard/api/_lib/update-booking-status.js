/**
 * Appointment status update — clinic-scoped PostgreSQL write on bookings.
 * Auth: dentaflow_session cookie → clinic_id.
 *
 * POST /api/update-status
 * PATCH /api/roster  (and POST /api/roster?action=status)
 */
'use strict';

const { applyCors } = require('./auth-crypto');
const { query } = require('./db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  validateStatusUpdate,
} = require('./validation');
const { blastWaitlistSlot } = require('./waitlist-blast');

const UPDATE_STATUS_SQL = `
  UPDATE bookings
  SET status = $1::appointment_status,
      cancel_reason = CASE WHEN $1::text = 'Annule' THEN $4 ELSE NULL END,
      care_started_at = CASE
        WHEN $1::text = 'En soin' THEN COALESCE(care_started_at, NOW())
        ELSE care_started_at
      END,
      updated_at = NOW()
  WHERE clinic_id = $2
    AND (id::text = $3 OR cal_booking_uid = $3)
    AND COALESCE(booking_kind, 'visit') = 'visit'
  RETURNING
    id,
    clinic_id,
    cal_booking_uid,
    patient_name,
    patient_phone,
    treatment_name,
    status::text AS status,
    starts_at,
    duration_min,
    booking_kind,
    care_started_at,
    cancel_reason,
    notes,
    created_at,
    updated_at
`;

module.exports = async function handleStatusUpdate(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, PATCH, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'POST, PATCH, OPTIONS');

  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const session = requireClinicSession(req, res, { allowedRoles: ['assistant'] });
  if (!session) return;

  const parsed = validateStatusUpdate(req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  try {
    const result = await query(UPDATE_STATUS_SQL, [
      parsed.value.dbStatus,
      session.clinic_id,
      parsed.value.bookingId,
      parsed.value.cancelReason,
    ]);
    const updatedBooking = result.rows[0];
    if (!updatedBooking) {
      return res.status(404).json(createApiError('NOT_FOUND', 'Appointment not found'));
    }

    const payload = {
      ok: true,
      data: {
        ...updatedBooking,
        statusCode: parsed.value.statusCode,
      },
    };

    if (parsed.value.statusCode === 'annule') {
      payload.triggerCalCancel = true;
      try {
        payload.waitlistNotify = await blastWaitlistSlot(session.clinic_id, req, {
          topN: 3,
          batchId: `staff-cancel-${updatedBooking.id}`,
        });
      } catch (err) {
        console.error('[status-cancel-blast]', err?.message || err);
      }
    }

    return res.status(200).json(payload);
  } catch (err) {
    if (err?.code === '42703') {
      console.error('[update-status] bookings.updated_at is missing — run schema.sql');
    }
    if (err?.code === '22P02') {
      return res.status(400).json(
        createApiError('VALIDATION_ERROR', 'newStatus is not a valid appointment status')
      );
    }
    return sendDbError(res, err);
  }
};
