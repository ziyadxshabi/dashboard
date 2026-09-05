/**
 * Today's roster — clinic-scoped bookings from PostgreSQL.
 * Auth: dentaflow_session cookie → clinic_id.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const { createApiError, requireClinicSession, sendDbError } = require('./_lib/validation');
const handleStatusUpdate = require('./_lib/update-booking-status');

const ROSTER_SQL = `
  SELECT id, cal_booking_uid, patient_name, patient_phone, treatment_name, status, starts_at, duration_min, notes
  FROM bookings
  WHERE clinic_id = $1
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
  ORDER BY starts_at ASC
`;

function formatCasablancaHm(startsAt) {
  if (startsAt == null || startsAt === '') return '';
  const parsed = startsAt instanceof Date ? startsAt : new Date(startsAt);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Casablanca',
  });
}

function mapRosterRow(row) {
  const patientName = row.patient_name || '';
  const patientPhone = row.patient_phone || '';
  const treatmentName = row.treatment_name || '';
  const time = formatCasablancaHm(row.starts_at);

  return {
    id: row.id,
    name: patientName,
    patient_name: patientName,
    phone: patientPhone,
    patient_phone: patientPhone,
    motif: treatmentName,
    treatment_name: treatmentName,
    treatment: treatmentName,
    status: row.status,
    time,
    duration_min: row.duration_min,
    cal_booking_uid: row.cal_booking_uid,
    calBookingId: row.cal_booking_uid,
    notes: row.notes || '',
    starts_at: row.starts_at,
    startTime: row.starts_at,
    'Patient (Nom Complet)': patientName,
    'Téléphone (WhatsApp)': patientPhone,
    'Motif de Consultation': treatmentName,
    'Statut du RDV': row.status,
    'Cal Booking ID': row.cal_booking_uid,
    'Date & Heure du RDV': row.starts_at,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, POST, PATCH, OPTIONS');
    return res.status(204).end();
  }

  let action = '';
  try {
    action = new URL(String(req.url || ''), 'http://localhost').searchParams.get('action') || '';
  } catch {
    action = '';
  }

  if (req.method === 'PATCH' || (req.method === 'POST' && action === 'status')) {
    return handleStatusUpdate(req, res);
  }

  applyCors(res, 'GET, OPTIONS');

  if (req.method !== 'GET') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const session = requireClinicSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
  if (!session) return;

  try {
    const result = await query(ROSTER_SQL, [session.clinic_id]);
    const appointments = (result.rows || []).map(mapRosterRow);
    return res.status(200).json({ ok: true, data: appointments });
  } catch (err) {
    return sendDbError(res, err);
  }
};
