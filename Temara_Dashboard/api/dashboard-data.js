/**
 * Doctor dashboard KPIs — clinic-scoped aggregations on bookings.
 * Auth: dentaflow_session cookie → clinic_id.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const { createApiError, requireClinicSession, sendDbError } = require('./_lib/validation');

const HOUR_KEYS = Object.freeze([
  'hour_08',
  'hour_09',
  'hour_10',
  'hour_11',
  'hour_12',
  'hour_13',
  'hour_14',
  'hour_15',
  'hour_16',
  'hour_17',
  'hour_18',
]);

const DASHBOARD_KPI_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status::text NOT IN ('Annule', 'Annulé'))::int AS patients_today,
    COUNT(*) FILTER (
      WHERE status::text IN (
        'Confirme',
        'Confirmé',
        'En salle d''attente',
        'En soin',
        'Termine',
        'Terminé'
      )
    )::int AS accepted_plans,
    COUNT(*) FILTER (WHERE status::text = 'En attente')::int AS pending_plans,
    COUNT(*) FILTER (WHERE status::text IN ('No-show', 'No-Show'))::int AS no_shows
  FROM bookings
  WHERE clinic_id = $1
    AND COALESCE(booking_kind, 'visit') = 'visit'
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
`;

const WEEK_PATIENTS_SQL = `
  WITH days AS (
    SELECT (NOW() AT TIME ZONE 'Africa/Casablanca')::date - s.i AS day
    FROM generate_series(6, 0, -1) AS s(i)
  )
  SELECT
    d.day,
    COALESCE(b.patients, 0)::int AS patients
  FROM days d
  LEFT JOIN (
    SELECT
      (starts_at AT TIME ZONE 'Africa/Casablanca')::date AS day,
      COUNT(*) FILTER (WHERE status::text NOT IN ('Annule', 'Annulé'))::int AS patients
    FROM bookings
    WHERE clinic_id = $1
      AND COALESCE(booking_kind, 'visit') = 'visit'
      AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
        >= (NOW() AT TIME ZONE 'Africa/Casablanca')::date - 6
    GROUP BY 1
  ) b ON b.day = d.day
  ORDER BY d.day
`;

const HOURLY_TODAY_SQL = `
  SELECT
    EXTRACT(HOUR FROM starts_at AT TIME ZONE 'Africa/Casablanca')::int AS hour,
    COUNT(*) FILTER (WHERE status::text NOT IN ('Annule', 'Annulé'))::int AS patients
  FROM bookings
  WHERE clinic_id = $1
    AND COALESCE(booking_kind, 'visit') = 'visit'
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
  GROUP BY 1
`;

const OPEN_MINUTES = 11 * 60; // 08:00–19:00 Casablanca clinic grid

const RESERVED_TODAY_SQL = `
  SELECT COALESCE(SUM(duration_min), 0)::int AS reserved_min
  FROM bookings
  WHERE clinic_id = $1
    AND COALESCE(booking_kind, 'visit') = 'visit'
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
      = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
    AND status::text NOT IN ('Annule', 'Annulé')
`;

const TREATMENT_MIX_SQL = `
  SELECT
    COALESCE(NULLIF(TRIM(treatment_name), ''), 'Non précisé') AS name,
    COUNT(*)::int AS count
  FROM bookings
  WHERE clinic_id = $1
    AND COALESCE(booking_kind, 'visit') = 'visit'
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
      >= (NOW() AT TIME ZONE 'Africa/Casablanca')::date - 6
    AND status::text NOT IN ('Annule', 'Annulé')
  GROUP BY 1
  ORDER BY count DESC, name ASC
  LIMIT 12
`;

const PHONE_FIDELITY_SQL = `
  WITH this_week AS (
    SELECT DISTINCT TRIM(patient_phone) AS phone
    FROM bookings
    WHERE clinic_id = $1
      AND COALESCE(booking_kind, 'visit') = 'visit'
      AND patient_phone IS NOT NULL
      AND TRIM(patient_phone) <> ''
      AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
        >= (NOW() AT TIME ZONE 'Africa/Casablanca')::date - 6
      AND status::text NOT IN ('Annule', 'Annulé')
  ),
  prior AS (
    SELECT DISTINCT TRIM(patient_phone) AS phone
    FROM bookings
    WHERE clinic_id = $1
      AND COALESCE(booking_kind, 'visit') = 'visit'
      AND patient_phone IS NOT NULL
      AND TRIM(patient_phone) <> ''
      AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
        >= (NOW() AT TIME ZONE 'Africa/Casablanca')::date - 90
      AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
        < (NOW() AT TIME ZONE 'Africa/Casablanca')::date - 6
      AND status::text NOT IN ('Annule', 'Annulé')
  )
  SELECT
    (
      SELECT COUNT(*)::int FROM this_week tw
      WHERE EXISTS (SELECT 1 FROM prior p WHERE p.phone = tw.phone)
    ) AS returning_phones,
    (
      SELECT COUNT(*)::int FROM this_week tw
      WHERE NOT EXISTS (SELECT 1 FROM prior p WHERE p.phone = tw.phone)
    ) AS new_phones
`;

const MONTH_WEEKS_SQL = `
  WITH weeks AS (
    SELECT
      s.i AS week_index,
      (NOW() AT TIME ZONE 'Africa/Casablanca')::date - (7 * s.i) - 6 AS week_start,
      (NOW() AT TIME ZONE 'Africa/Casablanca')::date - (7 * s.i) AS week_end
    FROM generate_series(3, 0, -1) AS s(i)
  )
  SELECT
    w.week_index,
    w.week_start,
    w.week_end,
    COALESCE(b.patients, 0)::int AS patients
  FROM weeks w
  LEFT JOIN (
    SELECT
      GREATEST(
        0,
        LEAST(
          3,
          ((NOW() AT TIME ZONE 'Africa/Casablanca')::date
            - (starts_at AT TIME ZONE 'Africa/Casablanca')::date) / 7
        )
      ) AS week_index,
      COUNT(*) FILTER (WHERE status::text NOT IN ('Annule', 'Annulé'))::int AS patients
    FROM bookings
    WHERE clinic_id = $1
      AND COALESCE(booking_kind, 'visit') = 'visit'
      AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
        >= (NOW() AT TIME ZONE 'Africa/Casablanca')::date - 27
      AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
        <= (NOW() AT TIME ZONE 'Africa/Casablanca')::date
    GROUP BY 1
  ) b ON b.week_index = w.week_index
  ORDER BY w.week_start
`;

function emptyHourCounts() {
  const counts = {};
  for (const key of HOUR_KEYS) counts[key] = 0;
  return counts;
}

function mapHourlyRows(rows) {
  const counts = emptyHourCounts();
  for (const row of rows || []) {
    const hour = Number(row.hour);
    if (!Number.isInteger(hour) || hour < 8 || hour > 18) continue;
    const key = `hour_${String(hour).padStart(2, '0')}`;
    counts[key] = Number(row.patients) || 0;
  }
  return counts;
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

  try {
    const [kpiResult, weekResult, hourlyResult, monthResult, reservedResult, mixResult, fidelityResult] =
      await Promise.all([
        query(DASHBOARD_KPI_SQL, [session.clinic_id]),
        query(WEEK_PATIENTS_SQL, [session.clinic_id]),
        query(HOURLY_TODAY_SQL, [session.clinic_id]),
        query(MONTH_WEEKS_SQL, [session.clinic_id]),
        query(RESERVED_TODAY_SQL, [session.clinic_id]),
        query(TREATMENT_MIX_SQL, [session.clinic_id]),
        query(PHONE_FIDELITY_SQL, [session.clinic_id]),
      ]);
    const row = kpiResult.rows[0] || {};
    const weekPatients = (weekResult.rows || []).map((entry) => Number(entry.patients) || 0);
    while (weekPatients.length < 7) weekPatients.unshift(0);
    const monthWeeks = (monthResult.rows || []).map((entry) => Number(entry.patients) || 0);
    while (monthWeeks.length < 4) monthWeeks.unshift(0);
    const reservedMin = Number(reservedResult.rows[0]?.reserved_min) || 0;
    const fidelity = fidelityResult.rows[0] || {};
    const treatmentMix = (mixResult.rows || []).map((entry) => ({
      name: String(entry.name || 'Non précisé'),
      count: Number(entry.count) || 0,
    }));

    return res.status(200).json({
      ok: true,
      data: {
        patients_today: Number(row.patients_today) || 0,
        accepted_plans: Number(row.accepted_plans) || 0,
        pending_plans: Number(row.pending_plans) || 0,
        no_shows: Number(row.no_shows) || 0,
        reserved_min: reservedMin,
        open_min: OPEN_MINUTES,
        treatment_mix: treatmentMix,
        returning_phones: Number(fidelity.returning_phones) || 0,
        new_phones: Number(fidelity.new_phones) || 0,
        week_patients: weekPatients.slice(-7),
        month_weeks: monthWeeks.slice(-4),
        ...mapHourlyRows(hourlyResult.rows),
      },
    });
  } catch (err) {
    return sendDbError(res, err);
  }
};
