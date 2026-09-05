/**
 * Fill-gap — clinic-scoped waitlist candidates and optional booking insert.
 * Auth: dentaflow_session cookie. Roles: doctor | assistant.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  validateFillGapInput,
  STATUS_CODE_TO_DB,
} = require('./_lib/validation');

const FILL_GAP_CANDIDATES_SQL = `
  SELECT
    id,
    patient_name,
    patient_phone,
    patient_phone AS phone_e164,
    priority::text AS priority,
    notes,
    created_at
  FROM waitlist
  WHERE clinic_id = $1
    AND status = 'active'
  ORDER BY (lower(priority::text) = 'urgent') DESC, created_at ASC
  LIMIT 5
`;

const FILL_GAP_CANDIDATE_SQL = `
  SELECT id, patient_name, patient_phone, notes
  FROM waitlist
  WHERE id = $1 AND clinic_id = $2 AND status = 'active'
  LIMIT 1
`;

const FILL_GAP_INSERT_SQL = `
  INSERT INTO bookings (
    clinic_id,
    patient_name,
    patient_phone,
    starts_at,
    treatment_name,
    notes,
    status,
    duration_min,
    updated_at
  )
  VALUES (
    $1,
    $2,
    $3,
    (($4::date + $5::time) AT TIME ZONE 'Africa/Casablanca'),
    $6,
    $6,
    $7::appointment_status,
    30,
    NOW()
  )
  RETURNING
    id,
    clinic_id,
    patient_name,
    patient_phone AS phone_e164,
    patient_phone,
    starts_at,
    treatment_name AS motif,
    status::text AS status
`;

const FILL_GAP_MARK_FILLED_SQL = `
  UPDATE waitlist
  SET status = 'filled'
  WHERE id = $1 AND clinic_id = $2
`;

function mapCandidate(row) {
  return {
    id: row.id,
    patient_name: row.patient_name,
    phone_e164: row.phone_e164 || row.patient_phone,
    patient_phone: row.patient_phone,
    priority: row.priority,
    notes: row.notes || '',
    created_at: row.created_at,
  };
}

function mapBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    patient_name: row.patient_name,
    phone_e164: row.phone_e164 || row.patient_phone,
    starts_at: row.starts_at,
    motif: row.motif || '',
    status: 'en_attente',
  };
}

async function loadCandidates(clinicId) {
  const result = await query(FILL_GAP_CANDIDATES_SQL, [clinicId]);
  return (result.rows || []).map(mapCandidate);
}

module.exports = async function handler(req, res) {
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

  const parsed = validateFillGapInput(req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  const { slotDate, slotTime, reason, candidateId } = parsed.value;

  try {
    let booking = null;

    if (candidateId) {
      const match = await query(FILL_GAP_CANDIDATE_SQL, [candidateId, session.clinic_id]);
      const candidate = match.rows[0];
      if (!candidate) {
        return res.status(404).json(createApiError('NOT_FOUND', 'Waitlist candidate not found'));
      }

      const motif = reason || candidate.notes || 'Créneau comblé';
      const inserted = await query(FILL_GAP_INSERT_SQL, [
        session.clinic_id,
        candidate.patient_name,
        candidate.patient_phone,
        slotDate,
        slotTime,
        motif,
        STATUS_CODE_TO_DB.en_attente,
      ]);
      booking = mapBooking(inserted.rows[0]);
      await query(FILL_GAP_MARK_FILLED_SQL, [candidate.id, session.clinic_id]);
    }

    const candidates = await loadCandidates(session.clinic_id);
    return res.status(200).json({
      ok: true,
      data: { candidates, booking },
    });
  } catch (err) {
    return sendDbError(res, err);
  }
};
