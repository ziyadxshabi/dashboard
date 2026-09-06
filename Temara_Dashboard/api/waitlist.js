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
  SELECT id, patient_name, patient_phone, priority, notes, status, created_at, sms_consent, last_notified_at
  FROM waitlist
  WHERE clinic_id = $1 AND status = 'active'
  ORDER BY
    CASE priority::text
      WHEN 'Urgent' THEN 0
      WHEN 'Haute' THEN 1
      WHEN 'Moyenne' THEN 2
      WHEN 'Normale' THEN 2
      ELSE 3
    END,
    created_at ASC
`;

const WAITLIST_INSERT_SQL = `
  INSERT INTO waitlist (clinic_id, patient_name, patient_phone, priority, notes, status, sms_consent, consent_at)
  VALUES ($1, $2, $3, $4, $5, 'active', $6, CASE WHEN $6 THEN NOW() ELSE NULL END)
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
    sms_consent: row.sms_consent !== false,
    last_notified_at: row.last_notified_at || null,
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

  const { patientName, phone, priority, notes, smsConsent } = parsed.value;
  const result = await query(WAITLIST_INSERT_SQL, [
    session.clinic_id,
    patientName,
    phone,
    priority,
    notes,
    smsConsent !== false,
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

  const session = requireClinicSession(req, res, { allowedRoles: ['assistant'] });
  if (!session) return;

  try {
    return await handlePost(req, res, session);
  } catch (err) {
    return sendDbError(res, err);
  }
};
