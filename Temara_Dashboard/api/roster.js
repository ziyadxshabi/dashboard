/**
 * Roster — clinic-scoped bookings from PostgreSQL.
 * GET /api/roster                 today's appointments
 * GET /api/roster?from=&to=       inclusive Casablanca date range (max 92 days)
 * GET /api/roster?view=directory  phone-keyed patient directory
 * GET /api/roster?view=gaps&date= chair gaps for a day (default today)
 * Auth: dentaflow_session cookie → clinic_id.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const { createApiError, requireClinicSession, sendDbError } = require('./_lib/validation');
const handleStatusUpdate = require('./_lib/update-booking-status');
const {
  DATE_SQL,
  DIRECTORY_BOOKING_LIMIT,
  casablancaYmd,
  computeGaps,
  groupDirectory,
  mapBookingRow,
  parseIsoDate,
  searchParamsFromReq,
  validateDateRange,
} = require('./_lib/booking-queries');

const BOOKING_COLUMNS = `
  id, cal_booking_uid, patient_name, patient_phone, treatment_name,
  status, starts_at, duration_min, notes
`;

const TODAY_SQL = `
  SELECT ${BOOKING_COLUMNS}
  FROM bookings
  WHERE clinic_id = $1
    AND ${DATE_SQL} = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
  ORDER BY starts_at ASC
`;

const RANGE_SQL = `
  SELECT ${BOOKING_COLUMNS}
  FROM bookings
  WHERE clinic_id = $1
    AND ${DATE_SQL} >= $2::date
    AND ${DATE_SQL} <= $3::date
  ORDER BY starts_at ASC
`;

const DAY_SQL = `
  SELECT ${BOOKING_COLUMNS}
  FROM bookings
  WHERE clinic_id = $1
    AND ${DATE_SQL} = $2::date
  ORDER BY starts_at ASC
`;

const DIRECTORY_SQL = `
  SELECT ${BOOKING_COLUMNS}
  FROM bookings
  WHERE clinic_id = $1
  ORDER BY starts_at DESC
  LIMIT $2
`;

function selectWithEmail(sql) {
  return sql.replace(BOOKING_COLUMNS, `${BOOKING_COLUMNS}, patient_email`);
}

async function queryBookings(sql, params) {
  try {
    return await query(selectWithEmail(sql), params);
  } catch (err) {
    if (err?.code === '42703') {
      return query(sql, params);
    }
    throw err;
  }
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

  const params = searchParamsFromReq(req);
  const view = String(params.get('view') || req.query?.view || '').trim().toLowerCase();
  const fromParam = params.get('from') || req.query?.from;
  const toParam = params.get('to') || req.query?.to;
  const dateParam = params.get('date') || req.query?.date;

  try {
    if (view === 'directory') {
      const result = await queryBookings(DIRECTORY_SQL, [session.clinic_id, DIRECTORY_BOOKING_LIMIT]);
      const directory = groupDirectory(result.rows || []);
      return res.status(200).json({ ok: true, view: 'directory', data: directory });
    }

    if (view === 'gaps') {
      const day = parseIsoDate(dateParam) || casablancaYmd();
      const result = await queryBookings(DAY_SQL, [session.clinic_id, day]);
      const bookings = (result.rows || []).map(mapBookingRow);
      const gaps = computeGaps(result.rows || [], day);
      return res.status(200).json({
        ok: true,
        view: 'gaps',
        data: { date: day, bookings, gaps },
      });
    }

    if (fromParam || toParam) {
      const range = validateDateRange(fromParam, toParam);
      if (!range.ok) {
        return res.status(400).json(createApiError('VALIDATION_ERROR', range.error));
      }
      const result = await queryBookings(RANGE_SQL, [session.clinic_id, range.from, range.to]);
      const appointments = (result.rows || []).map(mapBookingRow);
      return res.status(200).json({
        ok: true,
        from: range.from,
        to: range.to,
        data: appointments,
      });
    }

    const result = await queryBookings(TODAY_SQL, [session.clinic_id]);
    const appointments = (result.rows || []).map(mapBookingRow);
    return res.status(200).json({ ok: true, data: appointments });
  } catch (err) {
    return sendDbError(res, err);
  }
};
