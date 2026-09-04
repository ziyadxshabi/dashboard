/**
 * Cal.com webhook → PostgreSQL bookings sync.
 * Public endpoint (no JWT). Optional HMAC via CALCOM_WEBHOOK_SECRET.
 */
'use strict';

const crypto = require('crypto');
const { query } = require('../_lib/db');
const { compactPhone, sendDbError } = require('../_lib/validation');

const DEFAULT_SLUG = 'temara';
const DEFAULT_DURATION_MIN = 30;

const INSERT_CREATED_SQL = `
  INSERT INTO bookings (
    clinic_id, cal_booking_uid, patient_name, patient_phone,
    treatment_name, status, starts_at, duration_min, notes
  )
  VALUES ($1, $2, $3, $4, $5, 'Confirme', $6, $7, $8)
  ON CONFLICT (cal_booking_uid) DO UPDATE SET
    starts_at = EXCLUDED.starts_at,
    duration_min = EXCLUDED.duration_min,
    status = 'Confirme'
`;

const UPDATE_RESCHEDULED_SQL = `
  UPDATE bookings
  SET starts_at = $1, duration_min = $2, notes = $3
  WHERE cal_booking_uid = $4
`;

const UPDATE_CANCELLED_SQL = `
  UPDATE bookings
  SET status = 'Annule'
  WHERE cal_booking_uid = $1
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

function parsePayload(req, rawBody) {
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

function normalizeEventName(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[.\s-]+/g, '_');
}

function extractBooking(body) {
  if (body.payload && typeof body.payload === 'object') return body.payload;
  if (body.booking && typeof body.booking === 'object') return body.booking;
  if (body.data && typeof body.data === 'object') return body.data;
  return body;
}

function extractEventName(body, booking) {
  return normalizeEventName(
    body.triggerEvent ||
    body.type ||
    body.event ||
    booking.triggerEvent ||
    booking.status
  );
}

function extractUid(booking) {
  return firstString(
    booking.uid,
    booking.bookingUid,
    booking.booking_uid,
    booking.iCalUID,
    booking.id
  );
}

function extractAttendee(booking) {
  const attendees = Array.isArray(booking.attendees) ? booking.attendees : [];
  return attendees[0] && typeof attendees[0] === 'object' ? attendees[0] : {};
}

function extractPatientName(booking) {
  const attendee = extractAttendee(booking);
  const responses = booking.responses && typeof booking.responses === 'object' ? booking.responses : {};
  return firstString(
    attendee.name,
    responses.name,
    booking.metadata?.name,
    'Patient'
  );
}

function extractPatientPhone(booking) {
  const attendee = extractAttendee(booking);
  const responses = booking.responses && typeof booking.responses === 'object' ? booking.responses : {};
  const candidates = [
    attendee.phoneNumber,
    attendee.phone,
    booking.smsReminderNumber,
    responses.phone,
    responses.phoneNumber,
    responses.telephone,
    responses['Téléphone'],
    booking.metadata?.phone,
  ];
  for (const candidate of candidates) {
    const compact = compactPhone(unwrapValue(candidate));
    if (compact) return compact;
  }
  return '';
}

function extractTreatment(booking) {
  const eventType = booking.eventType && typeof booking.eventType === 'object' ? booking.eventType : {};
  return firstString(
    booking.title,
    eventType.title,
    booking.eventTitle,
    booking.type,
    'Consultation'
  );
}

function extractNotes(booking) {
  return firstString(booking.description, booking.additionalNotes, booking.notes) || null;
}

function extractStart(booking) {
  return firstString(booking.startTime, booking.start, booking.startsAt);
}

function durationMin(booking) {
  const start = Date.parse(extractStart(booking));
  const end = Date.parse(firstString(booking.endTime, booking.end, booking.endsAt));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const explicit = Number(booking.duration || booking.length || booking.duration_min);
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
    return DEFAULT_DURATION_MIN;
  }
  return Math.max(1, Math.round((end - start) / 60000));
}

async function resolveClinicId(booking) {
  const eventType = booking.eventType && typeof booking.eventType === 'object' ? booking.eventType : {};
  const organizer = booking.organizer && typeof booking.organizer === 'object' ? booking.organizer : {};
  const candidates = [
    booking.eventTypeId,
    eventType.id,
    eventType.slug,
    booking.type,
    organizer.username,
    organizer.email,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const result = await query(
      `SELECT id FROM clinics
       WHERE cal_event_type_id = $1
          OR slug = $1
          OR sms_booking_url ILIKE '%' || $1 || '%'
       LIMIT 1`,
      [candidate]
    );
    if (result.rows[0]?.id) return result.rows[0].id;
  }

  const fallback = await query(
    `SELECT id FROM clinics WHERE slug = $1 LIMIT 1`,
    [DEFAULT_SLUG]
  );
  return fallback.rows[0]?.id || null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
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

  const body = parsePayload(req, rawBody);
  const booking = extractBooking(body);
  const event = extractEventName(body, booking);
  const uid = extractUid(booking);

  try {
    if (event === 'BOOKING_CREATED' || event === 'BOOKING_RESCHEDULED' || event === 'BOOKING_CANCELLED') {
      if (!uid) {
        return res.status(400).json({ ok: false, error: 'Missing booking uid' });
      }
    }

    if (event === 'BOOKING_CREATED') {
      const clinicId = await resolveClinicId(booking);
      if (!clinicId) {
        return res.status(404).json({ ok: false, error: 'Clinic not found' });
      }
      const startsAt = extractStart(booking);
      if (!startsAt) {
        return res.status(400).json({ ok: false, error: 'Missing startTime' });
      }
      await query(INSERT_CREATED_SQL, [
        clinicId,
        uid,
        extractPatientName(booking),
        extractPatientPhone(booking),
        extractTreatment(booking),
        startsAt,
        durationMin(booking),
        extractNotes(booking),
      ]);
    } else if (event === 'BOOKING_RESCHEDULED') {
      const startsAt = extractStart(booking);
      if (!startsAt) {
        return res.status(400).json({ ok: false, error: 'Missing startTime' });
      }
      await query(UPDATE_RESCHEDULED_SQL, [
        startsAt,
        durationMin(booking),
        extractNotes(booking),
        uid,
      ]);
    } else if (event === 'BOOKING_CANCELLED') {
      await query(UPDATE_CANCELLED_SQL, [uid]);
    }

    return res.status(200).json({
      ok: true,
      event: event || body.triggerEvent || null,
      bookingUid: uid || null,
    });
  } catch (err) {
    return sendDbError(res, err);
  }
};
