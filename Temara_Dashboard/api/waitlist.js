/**
 * Waitlist — clinic-scoped PostgreSQL reads/writes.
 * Auth: dentaflow_session cookie → clinic_id.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  validateWaitlistInput,
} = require('./_lib/validation');

const WAITLIST_GET_SQL = `
  SELECT id, patient_name, patient_phone, priority, notes, status, created_at
  FROM waitlist
  WHERE clinic_id = $1 AND status = 'active'
  ORDER BY created_at DESC
`;

const WAITLIST_INSERT_SQL = `
  INSERT INTO waitlist (clinic_id, patient_name, patient_phone, priority, notes, status)
  VALUES ($1, $2, $3, $4, $5, 'active')
  RETURNING id
`;

function mapWaitlistRow(row) {
  const patientName = row.patient_name || '';
  const patientPhone = row.patient_phone || '';
  const notes = row.notes || '';
  const priority = row.priority || 'Normale';

  return {
    id: row.id,
    nom: patientName,
    patient_name: patientName,
    name: patientName,
    telephone: patientPhone,
    patient_phone: patientPhone,
    phone: patientPhone,
    priorite: priority,
    priority,
    motif: notes,
    reason: notes,
    notes,
    created_at: row.created_at,
    status: row.status,
  };
}

async function handleGet(req, res, session) {
  const result = await query(WAITLIST_GET_SQL, [session.clinic_id]);
  const rows = (result.rows || []).map(mapWaitlistRow);
  return res.status(200).json({ ok: true, data: rows });
}

async function handlePost(req, res, session) {
  const parsed = validateWaitlistInput(req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  const { patientName, phone, priority, notes } = parsed.value;
  const result = await query(WAITLIST_INSERT_SQL, [
    session.clinic_id,
    patientName,
    phone,
    priority,
    notes,
  ]);
  const insertedRow = result.rows[0];

  return res.status(200).json({
    ok: true,
    message: "Patient ajouté à la liste d'attente",
    id: insertedRow.id,
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'GET, POST, OPTIONS');

  if (req.method === 'GET') {
    const session = requireClinicSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
    if (!session) return;
    try {
      return await handleGet(req, res, session);
    } catch (err) {
      return sendDbError(res, err);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const session = requireClinicSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
  if (!session) return;

  try {
    return await handlePost(req, res, session);
  } catch (err) {
    return sendDbError(res, err);
  }
};
