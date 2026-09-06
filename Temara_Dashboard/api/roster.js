/**
 * Clinic-scoped bookings from PostgreSQL.
 * Auth: dentaflow_session cookie → clinic_id.
 *
 * GET /api/roster                 → today's roster (Africa/Casablanca)
 * GET /api/roster?from&to         → inclusive date range, max 42 days
 * GET /api/roster?q=              → name/phone search, last 90 days
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const { createApiError, requireClinicSession, sendDbError } = require('./_lib/validation');
const handleStatusUpdate = require('./_lib/update-booking-status');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROSTER_DAYS = 42;
const SEARCH_LOOKBACK_DAYS = 90;
const MAX_QUERY_LEN = 80;

const ROSTER_TODAY_SQL = `
  SELECT id, cal_booking_uid, patient_name, patient_phone, treatment_name, status, starts_at, duration_min, notes
  FROM bookings
  WHERE clinic_id = $1
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
  ORDER BY starts_at ASC
`;

const ROSTER_RANGE_SQL = `
  SELECT id, cal_booking_uid, patient_name, patient_phone, treatment_name, status, starts_at, duration_min, notes
  FROM bookings
  WHERE clinic_id = $1
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date >= $2::date
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date <= $3::date
  ORDER BY starts_at ASC
`;

const ROSTER_SEARCH_SQL = `
  SELECT id, cal_booking_uid, patient_name, patient_phone, treatment_name, status, starts_at, duration_min, notes
  FROM bookings
  WHERE clinic_id = $1
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
      >= (NOW() AT TIME ZONE 'Africa/Casablanca')::date - ${SEARCH_LOOKBACK_DAYS}
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
      <= (NOW() AT TIME ZONE 'Africa/Casablanca')::date
    AND (
      patient_name ILIKE $2
      OR patient_phone ILIKE $2
    )
  ORDER BY starts_at DESC
`;

const ROSTER_RANGE_SEARCH_SQL = `
  SELECT id, cal_booking_uid, patient_name, patient_phone, treatment_name, status, starts_at, duration_min, notes
  FROM bookings
  WHERE clinic_id = $1
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date >= $2::date
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date <= $3::date
    AND (
      patient_name ILIKE $4
      OR patient_phone ILIKE $4
    )
  ORDER BY starts_at DESC
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
  };
}

function parseIsoDate(raw) {
  const value = String(raw || '').trim();
  if (!ISO_DATE_RE.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const dt = new Date(utc);
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return { iso: value, utc };
}

function parseRosterRange(req) {
  let fromRaw = '';
  let toRaw = '';
  try {
    const parsed = new URL(String(req.url || ''), 'http://localhost');
    fromRaw = parsed.searchParams.get('from') || '';
    toRaw = parsed.searchParams.get('to') || '';
  } catch {
    fromRaw = '';
    toRaw = '';
  }

  if (!fromRaw && !toRaw) return { ok: true, range: null };

  if (!fromRaw || !toRaw) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'from and to are required together (YYYY-MM-DD)'),
    };
  }

  const from = parseIsoDate(fromRaw);
  const to = parseIsoDate(toRaw);
  if (!from || !to) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'from and to must be valid YYYY-MM-DD dates'),
    };
  }

  const days = Math.floor((to.utc - from.utc) / 86400000) + 1;
  if (days < 1) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'from must be on or before to'),
    };
  }
  if (days > MAX_ROSTER_DAYS) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', `date range cannot exceed ${MAX_ROSTER_DAYS} days`),
    };
  }

  return { ok: true, range: { from: from.iso, to: to.iso } };
}

function parseRosterQuery(req) {
  let q = '';
  try {
    q = new URL(String(req.url || ''), 'http://localhost').searchParams.get('q') || '';
  } catch {
    q = '';
  }
  q = String(q).trim();
  if (!q) return { ok: true, q: '' };
  if (q.length > MAX_QUERY_LEN) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', `q must be ${MAX_QUERY_LEN} characters or fewer`),
    };
  }
  return { ok: true, q };
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

  const parsedRange = parseRosterRange(req);
  if (!parsedRange.ok) {
    return res.status(400).json(parsedRange.error);
  }
  const parsedQuery = parseRosterQuery(req);
  if (!parsedQuery.ok) {
    return res.status(400).json(parsedQuery.error);
  }

  try {
    const like = parsedQuery.q ? `%${parsedQuery.q}%` : '';
    let result;
    if (parsedRange.range && like) {
      result = await query(ROSTER_RANGE_SEARCH_SQL, [
        session.clinic_id,
        parsedRange.range.from,
        parsedRange.range.to,
        like,
      ]);
    } else if (like) {
      result = await query(ROSTER_SEARCH_SQL, [session.clinic_id, like]);
    } else if (parsedRange.range) {
      result = await query(ROSTER_RANGE_SQL, [
        session.clinic_id,
        parsedRange.range.from,
        parsedRange.range.to,
      ]);
    } else {
      result = await query(ROSTER_TODAY_SQL, [session.clinic_id]);
    }
    const appointments = (result.rows || []).map(mapRosterRow);
    return res.status(200).json({ ok: true, data: appointments });
  } catch (err) {
    return sendDbError(res, err);
  }
};
