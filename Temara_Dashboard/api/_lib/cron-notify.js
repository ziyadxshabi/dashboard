'use strict';

const { query } = require('./db');
const { toE164MA, isValidMaMobileE164, displayNameUpper } = require('./phone-e164');
const { casablancaDateTimeParts } = require('./validation');
const { dispatchSms } = require('./notify');
const { loadClinicSmsConfig, clinicBookingUrl } = require('./twilio');
const templates = require('./sms-templates');
const { attachConfirmToken } = require('./booking-confirm');

const TARGET_MS = 24 * 60 * 60 * 1000;
const TOLERANCE_MS = 30 * 60 * 1000;
const UNCONFIRMED_TARGET_MS = 2 * 60 * 60 * 1000;
const UNCONFIRMED_TOLERANCE_MS = 15 * 60 * 1000;
const LEAK_DAYS = [3, 7, 14];

function casablancaDayStart(date = new Date()) {
  const parts = casablancaDateTimeParts(date);
  return new Date(`${parts.date}T00:00:00+01:00`);
}

function daysBetweenCasablanca(then, now = new Date()) {
  const a = casablancaDayStart(then);
  const b = casablancaDayStart(now);
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function inReminderWindow(startsAt, now = new Date()) {
  const start = startsAt instanceof Date ? startsAt : new Date(startsAt);
  if (Number.isNaN(start.getTime())) return false;
  const delta = start.getTime() - now.getTime();
  return Math.abs(delta - TARGET_MS) <= TOLERANCE_MS;
}

function inUnconfirmedWindow(startsAt, now = new Date()) {
  const start = startsAt instanceof Date ? startsAt : new Date(startsAt);
  if (Number.isNaN(start.getTime())) return false;
  const delta = start.getTime() - now.getTime();
  return Math.abs(delta - UNCONFIRMED_TARGET_MS) <= UNCONFIRMED_TOLERANCE_MS;
}

async function runReminders(clinicId, req) {
  const clinic = await loadClinicSmsConfig(clinicId);
  const url = clinicBookingUrl(clinic, req);
  const result = await query(
    `SELECT id, clinic_id, patient_name, patient_phone, patient_email, starts_at, status::text AS status
     FROM bookings
     WHERE clinic_id = $1
       AND COALESCE(booking_kind, 'visit') = 'visit'
       AND status::text IN ('Confirme')
       AND starts_at > NOW()
       AND starts_at < NOW() + INTERVAL '36 hours'`,
    [clinicId]
  );
  const due = (result.rows || []).filter((row) => inReminderWindow(row.starts_at));
  const sent = [];
  const skipped = [];
  for (const row of due) {
    const e164 = toE164MA(row.patient_phone);
    if (!isValidMaMobileE164(e164)) {
      skipped.push({ id: row.id, reason: 'invalid_phone' });
      continue;
    }
    const name = displayNameUpper(row.patient_name);
    const token = await attachConfirmToken(row.id);
    const confirmUrl = token ? `${url}${url.includes('?') ? '&' : '?'}confirm=${encodeURIComponent(token)}` : url;
    const sms = await dispatchSms({
      clinicId,
      bookingId: row.id,
      purpose: 'reminder',
      to: e164,
      body: templates.reminderSms(name, confirmUrl),
      req,
      lockKey: `lock:reminder:${row.id}:${casablancaDateTimeParts(row.starts_at).date}`,
    });
    if (sms.ok) sent.push({ id: row.id, sid: sms.sid });
    else skipped.push({ id: row.id, reason: sms.reason || 'send_failed' });
  }
  return { ok: true, sent, skipped, window: 'T-24h±30m' };
}

async function phoneHasFutureVisit(clinicId, phone, exceptBookingId) {
  const e164 = toE164MA(phone);
  const compact = String(phone || '').replace(/[\s.\-]/g, '');
  const result = await query(
    `SELECT id FROM bookings
     WHERE clinic_id = $1
       AND COALESCE(booking_kind, 'visit') = 'visit'
       AND status NOT IN ('Annule', 'No-show')
       AND starts_at > NOW()
       AND ($3::uuid IS NULL OR id <> $3)
       AND (
         regexp_replace(COALESCE(patient_phone, ''), '[\\s.\\-]', '', 'g') = $2
         OR regexp_replace(COALESCE(patient_phone, ''), '[\\s.\\-]', '', 'g') = $4
       )
     LIMIT 1`,
    [clinicId, compact, exceptBookingId || null, e164.replace(/^\+/, '')]
  );
  return Boolean(result.rows[0]);
}

async function runLeakDrip(clinicId, req) {
  const clinic = await loadClinicSmsConfig(clinicId);
  const url = clinicBookingUrl(clinic, req);
  const result = await query(
    `SELECT id, clinic_id, patient_name, patient_phone, patient_email, starts_at,
            status::text AS status, updated_at
     FROM bookings
     WHERE clinic_id = $1
       AND COALESCE(booking_kind, 'visit') = 'visit'
       AND status::text IN ('Annule', 'No-show')
       AND COALESCE(updated_at, starts_at) > NOW() - INTERVAL '16 days'`,
    [clinicId]
  );
  const sent = [];
  const skipped = [];
  for (const row of result.rows || []) {
    const age = daysBetweenCasablanca(row.updated_at || row.starts_at);
    if (!LEAK_DAYS.includes(age)) {
      skipped.push({ id: row.id, reason: 'not_due' });
      continue;
    }
    if (await phoneHasFutureVisit(clinicId, row.patient_phone, row.id)) {
      skipped.push({ id: row.id, reason: 'already_rebooked' });
      continue;
    }
    const e164 = toE164MA(row.patient_phone);
    if (!isValidMaMobileE164(e164)) {
      skipped.push({ id: row.id, reason: 'invalid_phone' });
      continue;
    }
    const name = displayNameUpper(row.patient_name);
    const sms = await dispatchSms({
      clinicId,
      bookingId: row.id,
      purpose: `leak_${age}`,
      to: e164,
      body: templates.leakSms(age, name, url),
      req,
      lockKey: `lock:leak:${row.id}:${age}`,
    });
    if (sms.ok) sent.push({ id: row.id, day: age, sid: sms.sid });
    else skipped.push({ id: row.id, reason: sms.reason || 'send_failed', day: age });
  }
  return { ok: true, sent, skipped };
}

async function runRecalls(clinicId, req) {
  const clinic = await loadClinicSmsConfig(clinicId);
  const url = clinicBookingUrl(clinic, req);
  const result = await query(
    `SELECT id, clinic_id, patient_name, patient_phone, due_on, status, patient_id
     FROM recalls
     WHERE clinic_id = $1
       AND status = 'open'
       AND due_on <= (NOW() AT TIME ZONE 'Africa/Casablanca')::date`,
    [clinicId]
  );
  const sent = [];
  const skipped = [];
  for (const row of result.rows || []) {
    if (row.patient_id) {
      const consent = await query(`SELECT sms_consent FROM patients WHERE id = $1 LIMIT 1`, [row.patient_id]);
      if (consent.rows[0] && consent.rows[0].sms_consent === false) {
        skipped.push({ id: row.id, reason: 'no_consent' });
        continue;
      }
    }
    const e164 = toE164MA(row.patient_phone);
    if (!isValidMaMobileE164(e164)) {
      skipped.push({ id: row.id, reason: 'invalid_phone' });
      continue;
    }
    const name = displayNameUpper(row.patient_name);
    const sms = await dispatchSms({
      clinicId,
      purpose: 'recall',
      to: e164,
      body: templates.recallSms(name, url),
      req,
      lockKey: `lock:recall:${row.id}:${row.due_on}`,
    });
    if (sms.ok) sent.push({ id: row.id, sid: sms.sid });
    else skipped.push({ id: row.id, reason: sms.reason || 'send_failed' });
  }
  return { ok: true, sent, skipped };
}

async function runUnconfirmed(clinicId) {
  const result = await query(
    `SELECT id, starts_at, patient_confirmed_at, confirmation_state
     FROM bookings
     WHERE clinic_id = $1
       AND COALESCE(booking_kind, 'visit') = 'visit'
       AND status::text = 'Confirme'
       AND patient_confirmed_at IS NULL
       AND starts_at > NOW()
       AND starts_at < NOW() + INTERVAL '3 hours'`,
    [clinicId]
  );
  const marked = [];
  const skipped = [];
  for (const row of result.rows || []) {
    if (!inUnconfirmedWindow(row.starts_at)) {
      skipped.push({ id: row.id, reason: 'outside_window' });
      continue;
    }
    await query(
      `UPDATE bookings
       SET confirmation_state = 'unconfirmed', updated_at = NOW()
       WHERE id = $1 AND patient_confirmed_at IS NULL`,
      [row.id]
    );
    marked.push({ id: row.id });
  }
  return { ok: true, marked, skipped, window: 'T-2h±15m' };
}

async function listClinics() {
  const result = await query('SELECT id, slug FROM clinics');
  return result.rows || [];
}

async function runRemindersAllClinics(req) {
  const clinics = await listClinics();
  const results = [];
  for (const clinic of clinics) {
    results.push({ clinicId: clinic.id, slug: clinic.slug, ...(await runReminders(clinic.id, req)) });
  }
  return { ok: true, results };
}

async function runLeakDripAllClinics(req) {
  const clinics = await listClinics();
  const results = [];
  for (const clinic of clinics) {
    results.push({ clinicId: clinic.id, slug: clinic.slug, ...(await runLeakDrip(clinic.id, req)) });
  }
  return { ok: true, results };
}

async function runRecallsAllClinics(req) {
  const clinics = await listClinics();
  const results = [];
  for (const clinic of clinics) {
    results.push({ clinicId: clinic.id, slug: clinic.slug, ...(await runRecalls(clinic.id, req)) });
  }
  return { ok: true, results };
}

async function runUnconfirmedAllClinics() {
  const clinics = await listClinics();
  const results = [];
  for (const clinic of clinics) {
    results.push({ clinicId: clinic.id, slug: clinic.slug, ...(await runUnconfirmed(clinic.id)) });
  }
  return { ok: true, results };
}

module.exports = {
  TARGET_MS,
  TOLERANCE_MS,
  UNCONFIRMED_TARGET_MS,
  UNCONFIRMED_TOLERANCE_MS,
  LEAK_DAYS,
  inReminderWindow,
  inUnconfirmedWindow,
  daysBetweenCasablanca,
  runReminders,
  runLeakDrip,
  runRecalls,
  runUnconfirmed,
  runRemindersAllClinics,
  runLeakDripAllClinics,
  runRecallsAllClinics,
  runUnconfirmedAllClinics,
};
