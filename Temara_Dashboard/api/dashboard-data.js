/**
 * Doctor dashboard KPIs — clinic-scoped aggregations on bookings + waitlist.
 * GET /api/dashboard-data?period=today|week|month
 * Auth: dentaflow_session cookie → clinic_id.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const { createApiError, requireClinicSession, sendDbError } = require('./_lib/validation');
const {
  DATE_SQL,
  HOUR_SQL,
  PHONE_KEY_SQL,
  STATUS,
  flattenHourKeys,
  hoursFromRows,
  noShowRate,
  occupancyCapacityMin,
  occupancyPct,
  parsePeriod,
  periodRange,
  searchParamsFromReq,
} = require('./_lib/booking-queries');

const TODAY_KPI_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status::text <> $2)::int AS patients_today,
    COUNT(*) FILTER (
      WHERE status::text IN ($3, $4, $5, $6)
    )::int AS accepted_plans,
    COUNT(*) FILTER (WHERE status::text = $7)::int AS pending_plans,
    COUNT(*) FILTER (WHERE status::text = $8)::int AS no_shows
  FROM bookings
  WHERE clinic_id = $1
    AND ${DATE_SQL} = $9::date
`;

const WEEK_PATIENTS_SQL = `
  WITH days AS (
    SELECT ($2::date - s.i) AS day
    FROM generate_series(6, 0, -1) AS s(i)
  )
  SELECT
    d.day,
    COALESCE(b.patients, 0)::int AS patients
  FROM days d
  LEFT JOIN (
    SELECT
      ${DATE_SQL} AS day,
      COUNT(*) FILTER (WHERE status::text <> $3)::int AS patients
    FROM bookings
    WHERE clinic_id = $1
      AND ${DATE_SQL} >= ($2::date - 6)
      AND ${DATE_SQL} <= $2::date
    GROUP BY 1
  ) b ON b.day = d.day
  ORDER BY d.day
`;

const PERIOD_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status::text <> $4)::int AS patients_period,
    COUNT(*) FILTER (WHERE status::text = $5)::int AS pending_period,
    COUNT(*) FILTER (WHERE status::text = $6)::int AS no_shows_period,
    COUNT(*) FILTER (WHERE status::text = $4)::int AS cancelled,
    COUNT(*) FILTER (WHERE status::text = $7)::int AS completed,
    COUNT(*) FILTER (WHERE status::text IN ($8, $9))::int AS in_chair,
    COUNT(*) FILTER (WHERE status::text = $10)::int AS confirme,
    COUNT(*) FILTER (WHERE status::text = $8)::int AS en_salle,
    COUNT(*) FILTER (WHERE status::text = $9)::int AS en_soin,
    COALESCE(SUM(duration_min) FILTER (WHERE status::text <> $4), 0)::int AS booked_min,
    COUNT(*) FILTER (
      WHERE cal_booking_uid IS NULL AND status::text <> $4
    )::int AS recovered_slots
  FROM bookings
  WHERE clinic_id = $1
    AND ${DATE_SQL} >= $2::date
    AND ${DATE_SQL} <= $3::date
`;

const HOURS_SQL = `
  SELECT
    ${HOUR_SQL} AS hour,
    COUNT(*) FILTER (WHERE status::text <> $4)::int AS n
  FROM bookings
  WHERE clinic_id = $1
    AND ${DATE_SQL} >= $2::date
    AND ${DATE_SQL} <= $3::date
  GROUP BY 1
`;

const WAITLIST_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status = 'active')::int AS waitlist_active,
    COUNT(*) FILTER (WHERE status = 'filled')::int AS waitlist_filled
  FROM waitlist
  WHERE clinic_id = $1
`;

const NEW_RETURNING_SQL = `
  WITH period_phones AS (
    SELECT DISTINCT ${PHONE_KEY_SQL} AS phone_key
    FROM bookings
    WHERE clinic_id = $1
      AND ${DATE_SQL} >= $2::date
      AND ${DATE_SQL} <= $3::date
      AND status::text <> $4
      AND COALESCE(patient_phone, '') <> ''
  ),
  first_seen AS (
    SELECT
      ${PHONE_KEY_SQL} AS phone_key,
      MIN(${DATE_SQL}) AS first_day
    FROM bookings
    WHERE clinic_id = $1
      AND COALESCE(patient_phone, '') <> ''
    GROUP BY 1
  )
  SELECT
    COUNT(*) FILTER (WHERE f.first_day >= $2::date AND f.first_day <= $3::date)::int AS new_phones,
    COUNT(*) FILTER (WHERE f.first_day < $2::date)::int AS returning_phones
  FROM period_phones p
  INNER JOIN first_seen f ON f.phone_key = p.phone_key
`;

function statusParams() {
  return [
    STATUS.annule,
    STATUS.confirme,
    STATUS.enSalle,
    STATUS.enSoin,
    STATUS.termine,
    STATUS.enAttente,
    STATUS.noShow,
  ];
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'GET, OPTIONS');

  if (req.method !== 'GET') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const session = requireClinicSession(req, res, { allowedRoles: ['doctor', 'assistant'] });
  if (!session) return;

  const params = searchParamsFromReq(req);
  const periodRaw = params.get('period') || req.query?.period || 'today';
  const period = parsePeriod(periodRaw);
  if (!period) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'period must be today, week, or month'));
  }

  const range = periodRange(period);
  const clinicId = session.clinic_id;
  const [
    annule,
    confirme,
    enSalle,
    enSoin,
    termine,
    enAttente,
    noShow,
  ] = statusParams();

  try {
    const [kpiResult, weekResult, periodResult, hoursResult, waitlistResult, identityResult] = await Promise.all([
      query(TODAY_KPI_SQL, [clinicId, annule, confirme, enSalle, enSoin, termine, enAttente, noShow, range.to]),
      query(WEEK_PATIENTS_SQL, [clinicId, range.to, annule]),
      query(PERIOD_SQL, [clinicId, range.from, range.to, annule, enAttente, noShow, termine, enSalle, enSoin, confirme]),
      query(HOURS_SQL, [clinicId, range.from, range.to, annule]),
      query(WAITLIST_SQL, [clinicId]),
      query(NEW_RETURNING_SQL, [clinicId, range.from, range.to, annule]),
    ]);

    const today = kpiResult.rows[0] || {};
    const periodRow = periodResult.rows[0] || {};
    const waitlist = waitlistResult.rows[0] || {};
    const identity = identityResult.rows[0] || {};
    const weekPatients = (weekResult.rows || []).map((entry) => Number(entry.patients) || 0);
    while (weekPatients.length < 7) weekPatients.unshift(0);

    const hours = hoursFromRows(hoursResult.rows);
    const bookedMin = Number(periodRow.booked_min) || 0;
    const capacityMin = occupancyCapacityMin(range.from, range.to);
    const pct = occupancyPct(bookedMin, capacityMin);
    const rate = noShowRate(periodRow.no_shows_period, periodRow.completed);

    return res.status(200).json({
      ok: true,
      data: {
        period,
        from: range.from,
        to: range.to,
        patients_today: Number(today.patients_today) || 0,
        accepted_plans: Number(today.accepted_plans) || 0,
        pending_plans: Number(today.pending_plans) || 0,
        no_shows: Number(today.no_shows) || 0,
        week_patients: weekPatients.slice(-7),
        patients_period: Number(periodRow.patients_period) || 0,
        pending_period: Number(periodRow.pending_period) || 0,
        cancelled: Number(periodRow.cancelled) || 0,
        completed: Number(periodRow.completed) || 0,
        in_chair: Number(periodRow.in_chair) || 0,
        recovered_slots: Number(periodRow.recovered_slots) || 0,
        hours,
        ...flattenHourKeys(hours),
        occupancy: {
          booked_min: bookedMin,
          capacity_min: capacityMin,
          pct,
        },
        occupancy_pct: pct,
        no_show_rate: rate,
        status_mix: {
          [STATUS.confirme]: Number(periodRow.confirme) || 0,
          [STATUS.enSalle]: Number(periodRow.en_salle) || 0,
          [STATUS.enSoin]: Number(periodRow.en_soin) || 0,
          [STATUS.enAttente]: Number(periodRow.pending_period) || 0,
          [STATUS.noShow]: Number(periodRow.no_shows_period) || 0,
          [STATUS.annule]: Number(periodRow.cancelled) || 0,
        },
        waitlist_active: Number(waitlist.waitlist_active) || 0,
        waitlist_filled: Number(waitlist.waitlist_filled) || 0,
        new_phones: Number(identity.new_phones) || 0,
        returning_phones: Number(identity.returning_phones) || 0,
      },
    });
  } catch (err) {
    return sendDbError(res, err);
  }
};
