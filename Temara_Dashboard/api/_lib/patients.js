'use strict';

const { query } = require('./db');
const { toE164MA, isValidMaMobileE164 } = require('./phone-e164');
const { sanitizeString } = require('./validation');

const INSURANCE_TYPES = new Set(['none', 'cnss', 'cnops', 'prive']);

function normalizeInsurance(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (INSURANCE_TYPES.has(value)) return value;
  return null;
}

async function ensurePatient(clinicId, { name, phone, smsConsent } = {}) {
  if (!clinicId) return null;
  const e164 = toE164MA(phone);
  if (!isValidMaMobileE164(e164)) return null;
  const displayName = sanitizeString(name, 100) || 'Patient';
  const consent = smsConsent !== false;

  const existing = await query(
    `SELECT id, display_name, sms_consent
     FROM patients
     WHERE clinic_id = $1 AND phone_e164 = $2
     LIMIT 1`,
    [clinicId, e164]
  );
  const row = existing.rows[0];
  if (row) {
    if ((!row.display_name || row.display_name === 'Patient') && displayName && displayName !== 'Patient') {
      await query(
        `UPDATE patients SET display_name = $1, updated_at = NOW() WHERE id = $2`,
        [displayName, row.id]
      );
    }
    return { id: row.id, phone_e164: e164, display_name: displayName, sms_consent: row.sms_consent };
  }

  const inserted = await query(
    `INSERT INTO patients (clinic_id, phone_e164, display_name, sms_consent, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (clinic_id, phone_e164) DO UPDATE SET
       display_name = CASE
         WHEN patients.display_name IS NULL OR btrim(patients.display_name) = '' OR patients.display_name = 'Patient'
         THEN EXCLUDED.display_name
         ELSE patients.display_name
       END,
       updated_at = NOW()
     RETURNING id, phone_e164, display_name, sms_consent`,
    [clinicId, e164, displayName, consent]
  );
  return inserted.rows[0] || null;
}

async function getPatientForClinic(clinicId, patientId) {
  if (!clinicId || !patientId) return null;
  const result = await query(
    `SELECT *
     FROM patients
     WHERE clinic_id = $1 AND id::text = $2
     LIMIT 1`,
    [clinicId, String(patientId)]
  );
  return result.rows[0] || null;
}

async function findPatientByPhone(clinicId, phone) {
  const e164 = toE164MA(phone);
  if (!clinicId || !isValidMaMobileE164(e164)) return null;
  const result = await query(
    `SELECT *
     FROM patients
     WHERE clinic_id = $1 AND phone_e164 = $2
     LIMIT 1`,
    [clinicId, e164]
  );
  return result.rows[0] || null;
}

async function markInboundAt(clinicId, phone) {
  const e164 = toE164MA(phone);
  if (!isValidMaMobileE164(e164)) return null;
  const patient = await ensurePatient(clinicId, { phone: e164, name: '' });
  if (!patient) return null;
  await query(
    `UPDATE patients SET last_inbound_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [patient.id]
  );
  return patient;
}

async function setSmsConsentByPhone(phone, consent) {
  const e164 = toE164MA(phone);
  if (!isValidMaMobileE164(e164)) return { patients: 0, waitlist: 0 };
  const allowed = consent !== false;
  const patients = await query(
    `UPDATE patients
     SET sms_consent = $1, updated_at = NOW()
     WHERE phone_e164 = $2`,
    [allowed, e164]
  );
  const waitlist = await query(
    `UPDATE waitlist
     SET sms_consent = $1
     WHERE public.normalize_ma_e164(patient_phone) = $2
        OR regexp_replace(COALESCE(patient_phone, ''), '[^0-9+]', '', 'g') = $2
        OR regexp_replace(COALESCE(patient_phone, ''), '[^0-9]', '', 'g') = $3`,
    [allowed, e164, e164.replace(/^\+/, '')]
  );
  return {
    patients: patients.rowCount || 0,
    waitlist: waitlist.rowCount || 0,
  };
}

async function hasOpenMessagingSession(e164) {
  if (!isValidMaMobileE164(e164)) return false;
  const fromPatients = await query(
    `SELECT 1 FROM patients
     WHERE phone_e164 = $1
       AND last_inbound_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    [e164]
  );
  if (fromPatients.rows[0]) return true;
  const fromSms = await query(
    `SELECT 1 FROM sms_messages
     WHERE to_phone = $1
       AND purpose = 'inbound'
       AND created_at > NOW() - INTERVAL '24 hours'
     LIMIT 1`,
    [e164]
  );
  return Boolean(fromSms.rows[0]);
}

module.exports = {
  INSURANCE_TYPES,
  normalizeInsurance,
  ensurePatient,
  getPatientForClinic,
  findPatientByPhone,
  markInboundAt,
  setSmsConsentByPhone,
  hasOpenMessagingSession,
};
