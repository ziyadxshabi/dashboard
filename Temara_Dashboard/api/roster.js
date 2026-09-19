/**
 * Clinic-scoped bookings from PostgreSQL.
 * Auth: dentaflow_session cookie → clinic_id.
 *
 * GET /api/roster                 → today's roster (Africa/Casablanca)
 * GET /api/roster?from&to         → inclusive date range, max 42 days
 * GET /api/roster?q=              → name/phone search on bookings, last 90 days
 * GET /api/roster?directory=1     → patients carnet (all-time; year/month/q optional)
 * GET /api/roster?patient_id=     → visit history for one patient
 * GET /api/roster?catalog=1       → treatment catalog + next free slot
 * GET /api/roster?recalls=open    → due 6-month recalls
 * POST /api/roster                → visit / walk-in / block / emergency_hold
 * GET /api/roster?action=patient-export → Loi 09-08 data-subject export
 * POST /api/roster?action=patient-erase → anonymize dossier, keep booking slots
 * GET /api/roster?action=acts           → NGAP catalog + clinic prices
 * PUT /api/roster?action=act-price      → doctor upsert of clinic_act_prices
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  validateRosterCreate,
  UUID_RE,
} = require('./_lib/validation');
const handleStatusUpdate = require('./_lib/update-booking-status');
const rosterOps = require('./_lib/roster-ops');
const { requireCronOrStaff } = require('./_lib/cron-auth');
const { runReminders, runRemindersAllClinics, runLeakDrip, runLeakDripAllClinics, runRecalls, runRecallsAllClinics, runUnconfirmed, runUnconfirmedAllClinics } = require('./_lib/cron-notify');
const roiOps = require('./_lib/roi-ops');
const { expectedCopayMad, insuranceLabel } = require('./_lib/treatments');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROSTER_DAYS = 42;
const SEARCH_LOOKBACK_DAYS = 90;
const MAX_QUERY_LEN = 80;

const ROSTER_COLUMNS = `
  bookings.id,
  bookings.cal_booking_uid,
  bookings.patient_name,
  bookings.patient_phone,
  bookings.treatment_name,
  bookings.status,
  bookings.starts_at,
  bookings.duration_min,
  bookings.notes,
  bookings.booking_kind,
  bookings.care_started_at,
  bookings.cancel_reason,
  bookings.buffer_min,
  bookings.patient_id,
  bookings.patient_confirmed_at,
  bookings.confirmation_state,
  bookings.charge_mad,
  bookings.staff_id,
  p.insurance_type,
  p.allergies,
  p.chronic_conditions,
  p.preferred_anesthetic,
  p.last_xray_on,
  p.sms_consent,
  p.email AS patient_email,
  p.clinical_notes,
  p.display_name AS patient_display_name,
  (
    SELECT COUNT(*)::int
    FROM bookings n
    WHERE n.clinic_id = bookings.clinic_id
      AND COALESCE(n.booking_kind, 'visit') = 'visit'
      AND n.status = 'No-show'
      AND n.patient_phone <> ''
      AND n.patient_phone = bookings.patient_phone
      AND (n.starts_at AT TIME ZONE 'Africa/Casablanca')::date
        >= (NOW() AT TIME ZONE 'Africa/Casablanca')::date - 90
  ) AS noshow_90d
`;

const ROSTER_FROM = `
  FROM bookings
  LEFT JOIN patients p ON p.id = bookings.patient_id
`;

const ROSTER_TODAY_SQL = `
  SELECT ${ROSTER_COLUMNS}
  ${ROSTER_FROM}
  WHERE bookings.clinic_id = $1
    AND (bookings.starts_at AT TIME ZONE 'Africa/Casablanca')::date = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
    AND ($2::uuid IS NULL OR bookings.staff_id = $2)
  ORDER BY bookings.starts_at ASC
`;

const ROSTER_RANGE_SQL = `
  SELECT ${ROSTER_COLUMNS}
  ${ROSTER_FROM}
  WHERE bookings.clinic_id = $1
    AND (bookings.starts_at AT TIME ZONE 'Africa/Casablanca')::date >= $2::date
    AND (bookings.starts_at AT TIME ZONE 'Africa/Casablanca')::date <= $3::date
    AND ($4::uuid IS NULL OR bookings.staff_id = $4)
  ORDER BY bookings.starts_at ASC
`;

const ROSTER_SEARCH_SQL = `
  SELECT ${ROSTER_COLUMNS}
  ${ROSTER_FROM}
  WHERE bookings.clinic_id = $1
    AND (bookings.starts_at AT TIME ZONE 'Africa/Casablanca')::date
      >= (NOW() AT TIME ZONE 'Africa/Casablanca')::date - ${SEARCH_LOOKBACK_DAYS}
    AND (bookings.starts_at AT TIME ZONE 'Africa/Casablanca')::date
      <= (NOW() AT TIME ZONE 'Africa/Casablanca')::date
    AND (
      bookings.patient_name ILIKE $2
      OR bookings.patient_phone ILIKE $2
      OR COALESCE(p.email, '') ILIKE $2
      OR COALESCE(p.display_name, '') ILIKE $2
    )
    AND ($3::uuid IS NULL OR bookings.staff_id = $3)
  ORDER BY bookings.starts_at DESC
`;

const PATIENT_DIRECTORY_SQL = `
  SELECT
    p.id,
    p.display_name,
    p.phone_e164,
    p.email,
    p.allergies,
    p.chronic_conditions,
    p.preferred_anesthetic,
    p.last_xray_on,
    p.sms_consent,
    p.insurance_type,
    p.clinical_notes,
    p.created_at,
    last.starts_at AS last_starts_at,
    last.treatment_name AS last_treatment,
    last.status AS last_status,
    last.charge_mad AS last_charge_mad,
    (
      SELECT COUNT(*)::int
      FROM bookings n
      WHERE n.clinic_id = p.clinic_id
        AND COALESCE(n.booking_kind, 'visit') = 'visit'
        AND n.status = 'No-show'
        AND (
          n.patient_id = p.id
          OR (n.patient_phone <> '' AND n.patient_phone = p.phone_e164)
        )
    ) AS noshow_count,
    (
      SELECT COUNT(*)::int
      FROM bookings hon
      WHERE hon.clinic_id = p.clinic_id
        AND COALESCE(hon.booking_kind, 'visit') = 'visit'
        AND hon.status::text NOT IN ('Annule', 'Annulé', 'No-show', 'No-Show')
        AND hon.charge_mad IS NOT NULL
        AND (
          hon.patient_id = p.id
          OR (hon.patient_phone <> '' AND hon.patient_phone = p.phone_e164)
        )
    ) AS honoraires_rows,
    (
      SELECT COALESCE(SUM(hon.charge_mad), 0)
      FROM bookings hon
      WHERE hon.clinic_id = p.clinic_id
        AND COALESCE(hon.booking_kind, 'visit') = 'visit'
        AND hon.status::text NOT IN ('Annule', 'Annulé', 'No-show', 'No-Show')
        AND hon.charge_mad IS NOT NULL
        AND (
          hon.patient_id = p.id
          OR (hon.patient_phone <> '' AND hon.patient_phone = p.phone_e164)
        )
    ) AS honoraires_saisis
  FROM patients p
  LEFT JOIN LATERAL (
    SELECT
      bookings.starts_at,
      bookings.treatment_name,
      bookings.status,
      bookings.charge_mad
    FROM bookings
    WHERE bookings.clinic_id = p.clinic_id
      AND COALESCE(bookings.booking_kind, 'visit') = 'visit'
      AND (
        bookings.patient_id = p.id
        OR (bookings.patient_phone <> '' AND bookings.patient_phone = p.phone_e164)
      )
    ORDER BY bookings.starts_at DESC
    LIMIT 1
  ) last ON true
  WHERE p.clinic_id = $1
    AND (
      $2::text IS NULL
      OR p.display_name ILIKE $2
      OR p.phone_e164 ILIKE $2
      OR COALESCE(p.email, '') ILIKE $2
    )
    AND (
      $2::text IS NOT NULL
      OR $3::int IS NULL
      OR EXTRACT(YEAR FROM last.starts_at AT TIME ZONE 'Africa/Casablanca') = $3
    )
    AND (
      $2::text IS NOT NULL
      OR $4::int IS NULL
      OR EXTRACT(MONTH FROM last.starts_at AT TIME ZONE 'Africa/Casablanca') = $4
    )
  ORDER BY LOWER(NULLIF(TRIM(p.display_name), '')) ASC NULLS LAST, p.created_at DESC
`;

const DIRECTORY_YEARS_SQL = `
  SELECT DISTINCT EXTRACT(YEAR FROM last.starts_at AT TIME ZONE 'Africa/Casablanca')::int AS year
  FROM patients p
  LEFT JOIN LATERAL (
    SELECT bookings.starts_at
    FROM bookings
    WHERE bookings.clinic_id = p.clinic_id
      AND COALESCE(bookings.booking_kind, 'visit') = 'visit'
      AND (
        bookings.patient_id = p.id
        OR (bookings.patient_phone <> '' AND bookings.patient_phone = p.phone_e164)
      )
    ORDER BY bookings.starts_at DESC
    LIMIT 1
  ) last ON true
  WHERE p.clinic_id = $1
    AND last.starts_at IS NOT NULL
  ORDER BY year DESC
`;

const DIRECTORY_MONTHS_SQL = `
  SELECT DISTINCT EXTRACT(MONTH FROM last.starts_at AT TIME ZONE 'Africa/Casablanca')::int AS month
  FROM patients p
  LEFT JOIN LATERAL (
    SELECT bookings.starts_at
    FROM bookings
    WHERE bookings.clinic_id = p.clinic_id
      AND COALESCE(bookings.booking_kind, 'visit') = 'visit'
      AND (
        bookings.patient_id = p.id
        OR (bookings.patient_phone <> '' AND bookings.patient_phone = p.phone_e164)
      )
    ORDER BY bookings.starts_at DESC
    LIMIT 1
  ) last ON true
  WHERE p.clinic_id = $1
    AND last.starts_at IS NOT NULL
    AND EXTRACT(YEAR FROM last.starts_at AT TIME ZONE 'Africa/Casablanca') = $2
  ORDER BY month
`;

const ROSTER_PATIENT_VISITS_SQL = `
  SELECT ${ROSTER_COLUMNS}
  ${ROSTER_FROM}
  WHERE bookings.clinic_id = $1
    AND COALESCE(bookings.booking_kind, 'visit') = 'visit'
    AND (
      bookings.patient_id = $2
      OR (
        bookings.patient_phone <> ''
        AND bookings.patient_phone = (
          SELECT patients.phone_e164
          FROM patients
          WHERE patients.id = $2
            AND patients.clinic_id = $1
        )
      )
    )
  ORDER BY bookings.starts_at DESC
`;

const ROSTER_RANGE_SEARCH_SQL = `
  SELECT ${ROSTER_COLUMNS}
  ${ROSTER_FROM}
  WHERE bookings.clinic_id = $1
    AND (bookings.starts_at AT TIME ZONE 'Africa/Casablanca')::date >= $2::date
    AND (bookings.starts_at AT TIME ZONE 'Africa/Casablanca')::date <= $3::date
    AND (
      bookings.patient_name ILIKE $4
      OR bookings.patient_phone ILIKE $4
      OR COALESCE(p.email, '') ILIKE $4
      OR COALESCE(p.display_name, '') ILIKE $4
    )
    AND ($5::uuid IS NULL OR bookings.staff_id = $5)
  ORDER BY bookings.starts_at DESC
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
    buffer_min: row.buffer_min,
    booking_kind: row.booking_kind || 'visit',
    care_started_at: row.care_started_at || null,
    cancel_reason: row.cancel_reason || null,
    noshow_90d: Number(row.noshow_90d) || 0,
    cal_booking_uid: row.cal_booking_uid,
    calBookingId: row.cal_booking_uid,
    notes: row.notes || '',
    starts_at: row.starts_at,
    startTime: row.starts_at,
    patient_id: row.patient_id || null,
    patient_confirmed_at: row.patient_confirmed_at || null,
    confirmation_state: row.confirmation_state || null,
    charge_mad: row.charge_mad == null ? null : Number(row.charge_mad),
    staff_id: row.staff_id || null,
    insurance_type: row.insurance_type || null,
    insurance: insuranceLabel(row.insurance_type) || '',
    allergies: row.allergies || '',
    chronic_conditions: row.chronic_conditions || '',
    preferred_anesthetic: row.preferred_anesthetic || '',
    last_xray_on: row.last_xray_on || null,
    sms_consent: row.sms_consent === true,
    patient_email: row.patient_email || '',
    email: row.patient_email || '',
    clinical_notes: row.clinical_notes || '',
    copay_mad: expectedCopayMad(treatmentName, row.insurance_type),
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

function searchParam(req, name) {
  try {
    return new URL(String(req.url || ''), 'http://localhost').searchParams.get(name) || '';
  } catch {
    return '';
  }
}

function parseStaffId(req) {
  const raw = searchParam(req, 'staff_id') || searchParam(req, 'staffId');
  return UUID_RE.test(raw) ? raw : null;
}

function parseYearMonth(req) {
  const yearRaw = searchParam(req, 'year');
  const monthRaw = searchParam(req, 'month');
  let year = null;
  let month = null;
  if (yearRaw) {
    const n = Number(yearRaw);
    if (!Number.isInteger(n) || n < 1990 || n > 2100) {
      return {
        ok: false,
        error: createApiError('VALIDATION_ERROR', 'year must be a valid calendar year'),
      };
    }
    year = n;
  }
  if (monthRaw) {
    const n = Number(monthRaw);
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      return {
        ok: false,
        error: createApiError('VALIDATION_ERROR', 'month must be 1–12'),
      };
    }
    if (year == null) {
      return {
        ok: false,
        error: createApiError('VALIDATION_ERROR', 'month requires year'),
      };
    }
    month = n;
  }
  return { ok: true, year, month };
}

function mapDirectoryPatient(row) {
  const honorairesRows = Number(row.honoraires_rows) || 0;
  const honoraires = honorairesRows > 0 ? Number(row.honoraires_saisis) || 0 : null;
  return {
    id: row.id,
    patient_id: row.id,
    name: row.display_name || '',
    display_name: row.display_name || '',
    phone: row.phone_e164 || '',
    phone_e164: row.phone_e164 || '',
    email: row.email || '',
    allergies: row.allergies || '',
    chronic_conditions: row.chronic_conditions || '',
    preferred_anesthetic: row.preferred_anesthetic || '',
    last_xray_on: row.last_xray_on || null,
    sms_consent: row.sms_consent === true,
    insurance_type: row.insurance_type || null,
    insurance: insuranceLabel(row.insurance_type) || '',
    clinical_notes: row.clinical_notes || '',
    created_at: row.created_at,
    last_starts_at: row.last_starts_at || null,
    last_treatment: row.last_treatment || '',
    last_status: row.last_status || '',
    last_charge_mad: row.last_charge_mad == null ? null : Number(row.last_charge_mad),
    noshow_count: Number(row.noshow_count) || 0,
    honoraires_rows: honorairesRows,
    honoraires_saisis: honoraires,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, POST, PUT, PATCH, OPTIONS');
    return res.status(204).end();
  }

  const action = searchParam(req, 'action');

  if (
    action === 'cron-reminders' ||
    action === 'cron-leak' ||
    action === 'cron-recalls' ||
    action === 'cron-unconfirmed'
  ) {
    applyCors(res, 'GET, POST, OPTIONS');
    const auth = requireCronOrStaff(req, res, requireClinicSession);
    if (!auth) return;
    try {
      if (action === 'cron-reminders') {
        const payload =
          auth.role === 'cron'
            ? await runRemindersAllClinics(req)
            : await runReminders(auth.clinic_id, req);
        return res.status(200).json(payload);
      }
      if (action === 'cron-leak') {
        const payload =
          auth.role === 'cron'
            ? await runLeakDripAllClinics(req)
            : await runLeakDrip(auth.clinic_id, req);
        return res.status(200).json(payload);
      }
      if (action === 'cron-recalls') {
        const payload =
          auth.role === 'cron'
            ? await runRecallsAllClinics(req)
            : await runRecalls(auth.clinic_id, req);
        return res.status(200).json(payload);
      }
      const payload =
        auth.role === 'cron'
          ? await runUnconfirmedAllClinics()
          : await runUnconfirmed(auth.clinic_id);
      return res.status(200).json(payload);
    } catch (err) {
      return sendDbError(res, err);
    }
  }

  if (req.method === 'PATCH' && action === 'patient') {
    applyCors(res, 'GET, POST, PATCH, OPTIONS');
    const session = requireClinicSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
    if (!session) return;
    try {
      return await roiOps.handlePatientPatch(req, res, session);
    } catch (err) {
      return sendDbError(res, err);
    }
  }

  if (req.method === 'PATCH' && action === 'clinic-settings') {
    applyCors(res, 'GET, POST, PATCH, OPTIONS');
    const session = requireClinicSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
    if (!session) return;
    try {
      return await roiOps.handleClinicSettingsPatch(req, res, session);
    } catch (err) {
      return sendDbError(res, err);
    }
  }

  if (req.method === 'PUT' && action === 'act-price') {
    applyCors(res, 'GET, POST, PUT, PATCH, OPTIONS');
    const session = requireClinicSession(req, res, { allowedRoles: ['doctor'] });
    if (!session) return;
    try {
      return await roiOps.handleActPricePut(req, res, session);
    } catch (err) {
      return sendDbError(res, err);
    }
  }

  if (req.method === 'PATCH' || (req.method === 'POST' && action === 'status')) {
    return handleStatusUpdate(req, res);
  }

  applyCors(res, 'GET, POST, PUT, PATCH, OPTIONS');

  if (req.method === 'GET') {
    const session = requireClinicSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
    if (!session) return;

    if (searchParam(req, 'catalog') === '1') {
      try {
        return await rosterOps.handleCatalog(res, session);
      } catch (err) {
        return sendDbError(res, err);
      }
    }

    if (action === 'patient') {
      req.query = { ...(req.query || {}), id: searchParam(req, 'id'), phone: searchParam(req, 'phone') };
      try {
        return await roiOps.handlePatientGet(req, res, session);
      } catch (err) {
        return sendDbError(res, err);
      }
    }

    if (action === 'patient-export') {
      req.query = { ...(req.query || {}), id: searchParam(req, 'id'), phone: searchParam(req, 'phone') };
      try {
        return await roiOps.handlePatientExport(req, res, session);
      } catch (err) {
        return sendDbError(res, err);
      }
    }

    if (action === 'clinic-settings') {
      try {
        return await roiOps.handleClinicSettingsGet(req, res, session);
      } catch (err) {
        return sendDbError(res, err);
      }
    }

    if (action === 'acts') {
      try {
        return await roiOps.handleActsGet(res, session);
      } catch (err) {
        return sendDbError(res, err);
      }
    }

    if (action === 'plans') {
      req.query = { ...(req.query || {}), patientId: searchParam(req, 'patientId') || searchParam(req, 'patient_id') };
      try {
        return await roiOps.handlePlansGet(req, res, session);
      } catch (err) {
        return sendDbError(res, err);
      }
    }

    if (action === 'stock') {
      try {
        return await roiOps.handleStockGet(res, session);
      } catch (err) {
        return sendDbError(res, err);
      }
    }

    if (action === 'memberships') {
      try {
        return await roiOps.handleMembershipsGet(res, session);
      } catch (err) {
        return sendDbError(res, err);
      }
    }

    if (searchParam(req, 'recalls')) {
      try {
        return await rosterOps.handleRecallsGet(res, session);
      } catch (err) {
        return sendDbError(res, err);
      }
    }

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
      const staffId = parseStaffId(req);
      const directory = searchParam(req, 'directory') === '1';
      const patientIdRaw = searchParam(req, 'patient_id') || searchParam(req, 'patientId');
      if (patientIdRaw) {
        if (!UUID_RE.test(patientIdRaw)) {
          return res.status(400).json(createApiError('VALIDATION_ERROR', 'patient_id must be a UUID'));
        }
        const visits = await query(ROSTER_PATIENT_VISITS_SQL, [session.clinic_id, patientIdRaw]);
        return res.status(200).json({
          ok: true,
          data: (visits.rows || []).map(mapRosterRow),
        });
      }
      if (directory) {
        const parsedPeriod = parseYearMonth(req);
        if (!parsedPeriod.ok) {
          return res.status(400).json(parsedPeriod.error);
        }
        const yearFilter = like ? null : parsedPeriod.year;
        const monthFilter = like ? null : parsedPeriod.month;
        const [dirResult, yearsResult, monthsResult] = await Promise.all([
          query(PATIENT_DIRECTORY_SQL, [
            session.clinic_id,
            like || null,
            yearFilter,
            monthFilter,
          ]),
          query(DIRECTORY_YEARS_SQL, [session.clinic_id]),
          parsedPeriod.year
            ? query(DIRECTORY_MONTHS_SQL, [session.clinic_id, parsedPeriod.year])
            : Promise.resolve({ rows: [] }),
        ]);
        const patients = (dirResult.rows || []).map(mapDirectoryPatient);
        return res.status(200).json({
          ok: true,
          data: {
            patients,
            years: (yearsResult.rows || []).map((row) => Number(row.year)).filter(Number.isFinite),
            months: (monthsResult.rows || []).map((row) => Number(row.month)).filter(Number.isFinite),
            total: patients.length,
            year: yearFilter,
            month: monthFilter,
            q: parsedQuery.q || '',
          },
        });
      }
      let result;
      if (parsedRange.range && like) {
        result = await query(ROSTER_RANGE_SEARCH_SQL, [
          session.clinic_id,
          parsedRange.range.from,
          parsedRange.range.to,
          like,
          staffId,
        ]);
      } else if (like) {
        result = await query(ROSTER_SEARCH_SQL, [session.clinic_id, like, staffId]);
      } else if (parsedRange.range) {
        result = await query(ROSTER_RANGE_SQL, [
          session.clinic_id,
          parsedRange.range.from,
          parsedRange.range.to,
          staffId,
        ]);
      } else {
        result = await query(ROSTER_TODAY_SQL, [session.clinic_id, staffId]);
      }
      const appointments = (result.rows || []).map(mapRosterRow);
      return res.status(200).json({ ok: true, data: appointments });
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
    if (action === 'recall') {
      return await rosterOps.handleRecallCreate(req, res, session);
    }
    if (action === 'release') {
      return await rosterOps.handleReleaseHold(req, res, session);
    }
    if (action === 'delete') {
      return await rosterOps.handleDeleteBlock(req, res, session);
    }
    if (action === 'patient') {
      return await roiOps.handlePatientPatch(req, res, session);
    }
    if (action === 'patient-erase') {
      return await roiOps.handlePatientErase(req, res, session);
    }
    if (action === 'clinic-settings') {
      return await roiOps.handleClinicSettingsPatch(req, res, session);
    }
    if (action === 'plan') {
      return await roiOps.handlePlanCreate(req, res, session);
    }
    if (action === 'plan-step') {
      return await roiOps.handlePlanStepPatch(req, res, session);
    }
    if (action === 'stock') {
      return await roiOps.handleStockUpsert(req, res, session);
    }
    if (action === 'stock-use') {
      return await roiOps.handleStockUse(req, res, session);
    }
    if (action === 'referral') {
      return await roiOps.handleReferral(req, res, session);
    }

    const parsed = validateRosterCreate(req.body ?? {});
    if (!parsed.ok) {
      return res.status(400).json(parsed.error);
    }
    return await rosterOps.handleCreate(req, res, session, parsed);
  } catch (err) {
    return sendDbError(res, err);
  }
};
