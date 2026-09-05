/**
 * Cal.com webhook → PostgreSQL bookings ingest.
 * Public endpoint (no JWT). Optional HMAC via CALCOM_WEBHOOK_SECRET.
 *
 * POST /api/webhooks/cal
 *   BOOKING_CREATED     → INSERT … ON CONFLICT DO UPDATE (status Confirme)
 *   BOOKING_RESCHEDULED → UPDATE starts_at, status Confirme, updated_at
 *   BOOKING_CANCELLED   → UPDATE status Annule, updated_at
 */
'use strict';

const crypto = require('crypto');
const { query } = require('../_lib/db');
const {
  compactPhone,
  createApiError,
  sendDbError,
  validatePhone,
  STATUS_CODE_TO_DB,
} = require('../_lib/validation');

const DEFAULT_SLUG = 'temara';
const DEFAULT_DURATION_MIN = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_CONFIRME = STATUS_CODE_TO_DB.confirme;
const STATUS_ANNULE = STATUS_CODE_TO_DB.annule;

const INSERT_CREATED_SQL = `
  INSERT INTO bookings (
    clinic_id, cal_booking_uid, patient_name, patient_phone,
    treatment_name, status, starts_at, duration_min, notes, updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6::appointment_status, $7, $8, $9, NOW())
  ON CONFLICT (cal_booking_uid) DO UPDATE SET
    clinic_id = EXCLUDED.clinic_id,
    patient_name = EXCLUDED.patient_name,
    patient_phone = EXCLUDED.patient_phone,
    treatment_name = EXCLUDED.treatment_name,
    status = EXCLUDED.status,
    starts_at = EXCLUDED.starts_at,
    duration_min = EXCLUDED.duration_min,
    notes = EXCLUDED.notes,
    updated_at = NOW()
  RETURNING id, cal_booking_uid, status::text AS status, starts_at
`;

const UPDATE_RESCHEDULED_SQL = `
  UPDATE bookings
  SET starts_at = $1,
      status = $2::appointment_status,
      updated_at = NOW()
  WHERE cal_booking_uid = $3
  RETURNING id, cal_booking_uid, status::text AS status, starts_at
`;

const UPDATE_CANCELLED_SQL = `
  UPDATE bookings
  SET status = $1::appointment_status,
      updated_at = NOW()
  WHERE cal_booking_uid = $2
  RETURNING id, cal_booking_uid, status::text AS status, starts_at
`;

function unwrapValue(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
    return raw.value;
  }
  return raw;
}

function firstString(...values) {
  for (const value of values) {
    const text = String(unwrapValue(value) ?? '').trim();
    if (text) return text;
  }
  return '';
}

function asRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.rawBody != null) return String(req.rawBody);
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

function parseBody(req, rawBody) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && typeof req.body !== 'string') {
    return req.body;
  }
  if (!rawBody) return {};
  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function verifyCalSignature(rawBody, headerValue, secret) {
  const provided = String(headerValue || '').trim().replace(/^sha256=/i, '');
  if (!provided) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function extractBooking(body) {
  if (body.payload && typeof body.payload === 'object') return body.payload;
  if (body.booking && typeof body.booking === 'object') return body.booking;
  if (body.data && typeof body.data === 'object') return body.data;
  return body;
}

function extractEventName(body, booking) {
  return String(
    body.triggerEvent ||
      body.type ||
      booking.triggerEvent ||
      booking.type ||
      body.event ||
      ''
  )
    .trim()
    .toUpperCase()
    .replace(/[.\s-]+/g, '_');
}

function extractUid(booking) {
  return firstString(booking.uid, booking.bookingId, booking.booking_uid, booking.bookingUid);
}

function extractAttendee(booking) {
  const attendees = Array.isArray(booking.attendees) ? booking.attendees : [];
  return attendees[0] && typeof attendees[0] === 'object' ? attendees[0] : {};
}

function extractPatientName(booking) {
  const responses = booking.responses && typeof booking.responses === 'object' ? booking.responses : {};
  const attendee = extractAttendee(booking);
  return firstString(responses.name, booking.name, attendee.name, 'Patient');
}

function extractEmail(booking) {
  const responses = booking.responses && typeof booking.responses === 'object' ? booking.responses : {};
  const attendee = extractAttendee(booking);
  return firstString(responses.email, booking.email, attendee.email);
}

function extractPhone(booking) {
  const responses = booking.responses && typeof booking.responses === 'object' ? booking.responses : {};
  const attendee = extractAttendee(booking);
  const raw = firstString(responses.phone, attendee.phoneNumber, attendee.phone, booking.smsReminderNumber);
  const validated = validatePhone(raw);
  if (validated.ok) return validated.value;
  return compactPhone(raw);
}

function extractMotif(booking) {
  return firstString(booking.title, booking.description, 'Consultation');
}

function extractPractitioner(booking) {
  const organizer = booking.organizer && typeof booking.organizer === 'object' ? booking.organizer : {};
  return firstString(organizer.name, 'Dr. Shabi');
}

function extractStart(booking) {
  return firstString(booking.startTime, booking.start, booking.startsAt);
}

function durationMin(booking) {
  const start = Date.parse(extractStart(booking));
  const end = Date.parse(firstString(booking.endTime, booking.end, booking.endsAt));
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return Math.max(1, Math.round((end - start) / 60000));
  }
  const explicit = Number(booking.duration || booking.length || booking.duration_min);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  return DEFAULT_DURATION_MIN;
}

function buildNotes(booking) {
  const practitioner = extractPractitioner(booking);
  const email = extractEmail(booking);
  const extra = firstString(booking.additionalNotes, booking.notes);
  return [practitioner, email, extra].filter(Boolean).join(' · ') || null;
}

async function resolveClinicId(booking, body) {
  const meta = booking.metadata && typeof booking.metadata === 'object' ? booking.metadata : {};
  const raw = firstString(
    meta.clinic_id,
    meta.clinicId,
    meta.clinicSlug,
    meta.slug,
    booking.clinic_id,
    booking.clinicSlug,
    body.clinic_id,
    DEFAULT_SLUG
  );

  if (UUID_RE.test(raw)) {
    const byId = await query('SELECT id FROM clinics WHERE id = $1::uuid LIMIT 1', [raw]);
    if (byId.rows[0]?.id) return byId.rows[0].id;
  }

  const slug = raw.toLowerCase();
  const bySlug = await query('SELECT id FROM clinics WHERE slug = $1 LIMIT 1', [slug]);
  if (bySlug.rows[0]?.id) return bySlug.rows[0].id;

  const fallback = await query('SELECT id FROM clinics WHERE slug = $1 LIMIT 1', [DEFAULT_SLUG]);
  return fallback.rows[0]?.id || null;
}

function jsonOk(res, action, bookingId) {
  return res.status(200).json({
    ok: true,
    action,
    bookingId: bookingId || null,
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const rawBody = asRawBody(req);
  const secret = String(process.env.CALCOM_WEBHOOK_SECRET || '').trim();
  if (secret) {
    const signature =
      req.headers['x-cal-signature-256'] ||
      req.headers['X-Cal-Signature-256'] ||
      req.headers['cal-signature'];
    if (!verifyCalSignature(rawBody, signature, secret)) {
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }
  }

  const body = parseBody(req, rawBody);
  const booking = extractBooking(body);
  const eventType = extractEventName(body, booking);
  const uid = extractUid(booking);

  try {
    if (eventType === 'BOOKING_CREATED' || eventType === 'BOOKING_RESCHEDULED' || eventType === 'BOOKING_CANCELLED') {
      if (!uid) {
        return res.status(400).json(createApiError('VALIDATION_ERROR', 'Missing booking uid'));
      }
    }

    if (eventType === 'BOOKING_CREATED') {
      const clinicId = await resolveClinicId(booking, body);
      if (!clinicId) {
        return res.status(404).json(createApiError('NOT_FOUND', 'Clinic not found'));
      }
      const startsAt = extractStart(booking);
      if (!startsAt) {
        return res.status(400).json(createApiError('VALIDATION_ERROR', 'Missing startTime'));
      }
      const result = await query(INSERT_CREATED_SQL, [
        clinicId,
        uid,
        extractPatientName(booking),
        extractPhone(booking),
        extractMotif(booking),
        STATUS_CONFIRME,
        startsAt,
        durationMin(booking),
        buildNotes(booking),
      ]);
      return jsonOk(res, eventType, result.rows[0]?.id);
    }

    if (eventType === 'BOOKING_RESCHEDULED') {
      const startsAt = extractStart(booking);
      if (!startsAt) {
        return res.status(400).json(createApiError('VALIDATION_ERROR', 'Missing startTime'));
      }
      const result = await query(UPDATE_RESCHEDULED_SQL, [startsAt, STATUS_CONFIRME, uid]);
      return jsonOk(res, eventType, result.rows[0]?.id);
    }

    if (eventType === 'BOOKING_CANCELLED') {
      const result = await query(UPDATE_CANCELLED_SQL, [STATUS_ANNULE, uid]);
      return jsonOk(res, eventType, result.rows[0]?.id);
    }

    return jsonOk(res, eventType || 'PING', null);
  } catch (err) {
    return sendDbError(res, err);
  }
};
