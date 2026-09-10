/**
 * Bulk SMS — clinic-scoped Twilio send (n8n Bulk SMS Blast + Force SMS).
 * Auth: dentaflow_session cookie. Roles: doctor | assistant.
 * Never reports sent without a Twilio SID.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  sanitizeString,
  validateBulkSmsInput,
  UUID_RE,
} = require('./_lib/validation');
const { toE164MA, isValidMaMobileE164, displayNameUpper } = require('./_lib/phone-e164');
const { isTwilioConfigured } = require('./_lib/twilio');
const { dispatchSms, sendSlack } = require('./_lib/notify');
const { bulkDefaultSms, forceTomorrowSms, SLACK } = require('./_lib/sms-templates');

const INSERT_AUDIT_SQL = `
  INSERT INTO sms_dispatch_log (clinic_id, staff_id, message, recipient_count, recipients)
  VALUES ($1, $2, $3, $4, $5::jsonb)
  RETURNING id, created_at
`;

function actionFrom(req, body) {
  const fromBody = String(body.action || '').trim().toLowerCase();
  if (fromBody) return fromBody;
  try {
    return String(new URL(String(req.url || ''), 'http://localhost').searchParams.get('action') || '')
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

async function resolveBookingRecipients(clinicId, ids) {
  const found = [];
  for (const raw of ids) {
    const token = String(raw || '').trim();
    if (!token) continue;
    if (UUID_RE.test(token)) {
      const row = await query(
        `SELECT id, patient_name, patient_phone
         FROM bookings
         WHERE clinic_id = $1 AND (id::text = $2 OR cal_booking_uid = $2)
         LIMIT 1`,
        [clinicId, token]
      );
      if (row.rows[0]) {
        found.push(row.rows[0]);
        continue;
      }
    }
    found.push({ id: null, patient_name: '', patient_phone: token });
  }
  return found;
}

async function loadTomorrowVisits(clinicId) {
  const result = await query(
    `SELECT id, patient_name, patient_phone
     FROM bookings
     WHERE clinic_id = $1
       AND COALESCE(booking_kind, 'visit') = 'visit'
       AND patient_phone <> ''
       AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
         = (NOW() AT TIME ZONE 'Africa/Casablanca')::date + 1`,
    [clinicId]
  );
  return result.rows || [];
}

async function loadConsentedPatients(clinicId) {
  const result = await query(
    `SELECT id, display_name AS patient_name, phone_e164 AS patient_phone
     FROM patients
     WHERE clinic_id = $1
       AND sms_consent IS TRUE
       AND phone_e164 <> ''
     LIMIT 100`,
    [clinicId]
  );
  return result.rows || [];
}

async function loadTodayVisits(clinicId) {
  const result = await query(
    `SELECT id, patient_name, patient_phone
     FROM bookings
     WHERE clinic_id = $1
       AND COALESCE(booking_kind, 'visit') = 'visit'
       AND patient_phone <> ''
       AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
         = (NOW() AT TIME ZONE 'Africa/Casablanca')::date`,
    [clinicId]
  );
  return result.rows || [];
}

async function sendToRows(clinicId, rows, bodyFor, req) {
  const sent = [];
  const skipped = [];
  for (const row of rows.slice(0, 100)) {
    const phone = row.patient_phone;
    const e164 = toE164MA(phone);
    if (!isValidMaMobileE164(e164)) {
      skipped.push({ id: row.id, phone, reason: 'invalid_phone' });
      await sendSlack(SLACK.badPhone(phone));
      continue;
    }
    const name = displayNameUpper(row.patient_name);
    const sms = await dispatchSms({
      clinicId,
      bookingId: bodyFor.purpose === 'bulk_patients' ? null : row.id,
      purpose: bodyFor.purpose,
      to: e164,
      body: bodyFor.message(name),
      req,
    });
    if (sms.ok && sms.sid) {
      sent.push({ id: row.id, sid: sms.sid, to: sms.to });
    } else {
      skipped.push({ id: row.id, phone: e164, reason: sms.reason || 'send_failed' });
    }
  }
  return { sent, skipped };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'POST, OPTIONS');

  if (req.method !== 'POST') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const session = requireClinicSession(req, res, { allowedRoles: ['doctor', 'assistant'] });
  if (!session) return;

  const body = { ...(req.body ?? {}), action: actionFrom(req, req.body ?? {}) };
  const parsed = validateBulkSmsInput(body);
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  try {
    let rows = [];
    const { message, recipients, action, useDefaultTemplate } = parsed.value;
    let messageFn;
    let purpose = 'bulk';
    let auditMessage = message;

    if (action === 'force-tomorrow') {
      rows = await loadTomorrowVisits(session.clinic_id);
      messageFn = (name) => forceTomorrowSms(name);
      purpose = 'force_tomorrow';
      auditMessage = forceTomorrowSms('{NAME}');
    } else if (action === 'today') {
      rows = await loadTodayVisits(session.clinic_id);
      messageFn = () => message;
      purpose = 'bulk_today';
    } else if (action === 'patients') {
      rows = await loadConsentedPatients(session.clinic_id);
      messageFn = (name) => message.replace(/\{NAME\}/g, name);
      purpose = 'bulk_patients';
    } else {
      rows = await resolveBookingRecipients(session.clinic_id, recipients);
      messageFn = useDefaultTemplate ? (name) => bulkDefaultSms(name) : () => message;
      auditMessage = useDefaultTemplate ? bulkDefaultSms('{NAME}') : message;
    }

    const { sent, skipped } = await sendToRows(
      session.clinic_id,
      rows,
      { purpose, message: messageFn },
      req
    );

    if (sent.length) {
      await query(INSERT_AUDIT_SQL, [
        session.clinic_id,
        session.sub || null,
        sanitizeString(auditMessage, 500),
        sent.length,
        JSON.stringify({ sent, skipped }),
      ]);
    }

    return res.status(200).json({
      ok: true,
      dispatchedCount: sent.length,
      skippedCount: skipped.length,
      twilioConfigured: isTwilioConfigured(),
      message: sanitizeString(auditMessage, 500),
      sent,
      skipped,
    });
  } catch (err) {
    return sendDbError(res, err);
  }
};
