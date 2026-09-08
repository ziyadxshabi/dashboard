/**
 * ROI loop ops on the existing roster function — patients, plans, stock, referral.
 * No extra Vercel file. No paperwork.
 */
'use strict';

const { query } = require('./db');
const { createApiError, sanitizeString, UUID_RE } = require('./validation');
const { toE164MA, isValidMaMobileE164, displayNameUpper } = require('./phone-e164');
const {
  ensurePatient,
  getPatientForClinic,
  findPatientByPhone,
  normalizeInsurance,
} = require('./patients');
const { expectedCopayMad, insuranceLabel } = require('./treatments');
const { dispatchSms } = require('./notify');
const { referralSms } = require('./sms-templates');

function mapPatient(row) {
  if (!row) return null;
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    phone_e164: row.phone_e164,
    display_name: row.display_name,
    email: row.email || '',
    allergies: row.allergies || '',
    chronic_conditions: row.chronic_conditions || '',
    preferred_anesthetic: row.preferred_anesthetic || '',
    last_xray_on: row.last_xray_on || null,
    insurance_type: row.insurance_type || null,
    insurance_label: insuranceLabel(row.insurance_type),
    sms_consent: row.sms_consent !== false,
    clinical_notes: row.clinical_notes || '',
    last_inbound_at: row.last_inbound_at || null,
  };
}

async function handlePatientGet(req, res, session) {
  const id = String(req.query?.id || '').trim();
  const phone = String(req.query?.phone || '').trim();
  let row = null;
  if (id) row = await getPatientForClinic(session.clinic_id, id);
  else if (phone) row = await findPatientByPhone(session.clinic_id, phone);
  else {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'id or phone is required'));
  }
  if (!row) {
    return res.status(404).json(createApiError('NOT_FOUND', 'Patient introuvable'));
  }
  return res.status(200).json({ ok: true, data: mapPatient(row) });
}

async function handlePatientPatch(req, res, session) {
  const body = req.body ?? {};
  const id = String(body.id || body.patientId || body.patient_id || '').trim();
  if (!id) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'id is required'));
  }
  const existing = await getPatientForClinic(session.clinic_id, id);
  if (!existing) {
    return res.status(404).json(createApiError('NOT_FOUND', 'Patient introuvable'));
  }

  const insurance = Object.prototype.hasOwnProperty.call(body, 'insurance_type')
    || Object.prototype.hasOwnProperty.call(body, 'insuranceType')
    ? normalizeInsurance(body.insurance_type ?? body.insuranceType)
    : existing.insurance_type;

  let phoneE164 = existing.phone_e164;
  const phoneRaw = body.phone || body.phone_e164 || body.phoneE164 || body.telephone;
  if (phoneRaw != null && String(phoneRaw).trim()) {
    const nextPhone = toE164MA(phoneRaw);
    if (!isValidMaMobileE164(nextPhone)) {
      return res.status(400).json(createApiError('VALIDATION_ERROR', 'Numéro de téléphone invalide'));
    }
    if (nextPhone !== existing.phone_e164) {
      const clash = await findPatientByPhone(session.clinic_id, nextPhone);
      if (clash && String(clash.id) !== String(existing.id)) {
        return res.status(409).json(createApiError('CONFLICT', 'Un dossier existe déjà avec ce numéro'));
      }
      phoneE164 = nextPhone;
    }
  }

  const displayName = sanitizeString(body.display_name ?? body.displayName ?? body.name, 100);
  const email = Object.prototype.hasOwnProperty.call(body, 'email')
    ? (sanitizeString(body.email, 160) || null)
    : existing.email;
  const notes = Object.prototype.hasOwnProperty.call(body, 'clinical_notes')
    || Object.prototype.hasOwnProperty.call(body, 'clinicalNotes')
    || Object.prototype.hasOwnProperty.call(body, 'notes')
    ? (sanitizeString(body.clinical_notes ?? body.clinicalNotes ?? body.notes, 1000) || null)
    : existing.clinical_notes;

  const updated = await query(
    `UPDATE patients
     SET display_name = COALESCE(NULLIF($3, ''), display_name),
         phone_e164 = $4,
         email = $5,
         allergies = $6,
         chronic_conditions = $7,
         preferred_anesthetic = $8,
         last_xray_on = $9::date,
         insurance_type = $10,
         sms_consent = COALESCE($11, sms_consent),
         clinical_notes = $12,
         updated_at = NOW()
     WHERE clinic_id = $1 AND id = $2
     RETURNING *`,
    [
      session.clinic_id,
      existing.id,
      displayName,
      phoneE164,
      email,
      Object.prototype.hasOwnProperty.call(body, 'allergies')
        ? (sanitizeString(body.allergies, 500) || null)
        : existing.allergies,
      Object.prototype.hasOwnProperty.call(body, 'chronic_conditions') || Object.prototype.hasOwnProperty.call(body, 'chronicConditions')
        ? (sanitizeString(body.chronic_conditions ?? body.chronicConditions, 500) || null)
        : existing.chronic_conditions,
      Object.prototype.hasOwnProperty.call(body, 'preferred_anesthetic') || Object.prototype.hasOwnProperty.call(body, 'preferredAnesthetic')
        ? (sanitizeString(body.preferred_anesthetic ?? body.preferredAnesthetic, 120) || null)
        : existing.preferred_anesthetic,
      Object.prototype.hasOwnProperty.call(body, 'last_xray_on') || Object.prototype.hasOwnProperty.call(body, 'lastXrayOn')
        ? (body.last_xray_on || body.lastXrayOn || null)
        : existing.last_xray_on,
      insurance,
      typeof body.sms_consent === 'boolean' ? body.sms_consent : (typeof body.smsConsent === 'boolean' ? body.smsConsent : null),
      notes,
    ]
  );

  if (displayName) {
    await query(
      `UPDATE bookings
       SET patient_name = $3, updated_at = NOW()
       WHERE clinic_id = $1 AND patient_id = $2`,
      [session.clinic_id, existing.id, displayName]
    );
  }
  if (phoneE164 !== existing.phone_e164) {
    await query(
      `UPDATE bookings
       SET patient_phone = $3, updated_at = NOW()
       WHERE clinic_id = $1 AND patient_id = $2`,
      [session.clinic_id, existing.id, phoneE164]
    );
  }

  return res.status(200).json({ ok: true, data: mapPatient(updated.rows[0]) });
}

function normalizeHmSetting(raw, fallback) {
  const value = String(raw || '').trim();
  const match = value.match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return fallback;
  return `${String(match[1]).padStart(2, '0')}:${match[2]}`;
}

async function handleClinicSettingsGet(_req, res, session) {
  try {
    const result = await query(
      `SELECT buffer_min, day_start, day_end, sms_reminders_enabled
       FROM clinics WHERE id = $1 LIMIT 1`,
      [session.clinic_id]
    );
    const row = result.rows[0] || {};
    return res.status(200).json({
      ok: true,
      data: {
        buffer_min: Number(row.buffer_min) || 10,
        day_start: normalizeHmSetting(row.day_start, '08:00'),
        day_end: normalizeHmSetting(row.day_end, '19:00'),
        sms_reminders_enabled: row.sms_reminders_enabled !== false,
      },
    });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      data: {
        buffer_min: 10,
        day_start: '08:00',
        day_end: '19:00',
        sms_reminders_enabled: true,
        degraded: true,
        error: err?.message || 'settings_unavailable',
      },
    });
  }
}

async function handleClinicSettingsPatch(req, res, session) {
  const body = req.body ?? {};
  const current = await query(
    `SELECT buffer_min, day_start, day_end, sms_reminders_enabled
     FROM clinics WHERE id = $1 LIMIT 1`,
    [session.clinic_id]
  );
  const row = current.rows[0] || {};
  const dayStart = Object.prototype.hasOwnProperty.call(body, 'day_start') || Object.prototype.hasOwnProperty.call(body, 'dayStart')
    ? normalizeHmSetting(body.day_start ?? body.dayStart, row.day_start || '08:00')
    : normalizeHmSetting(row.day_start, '08:00');
  const dayEnd = Object.prototype.hasOwnProperty.call(body, 'day_end') || Object.prototype.hasOwnProperty.call(body, 'dayEnd')
    ? normalizeHmSetting(body.day_end ?? body.dayEnd, row.day_end || '19:00')
    : normalizeHmSetting(row.day_end, '19:00');
  const smsEnabled = typeof body.sms_reminders_enabled === 'boolean'
    ? body.sms_reminders_enabled
    : (typeof body.smsRemindersEnabled === 'boolean'
      ? body.smsRemindersEnabled
      : row.sms_reminders_enabled !== false);

  const updated = await query(
    `UPDATE clinics
     SET day_start = $2, day_end = $3, sms_reminders_enabled = $4
     WHERE id = $1
     RETURNING buffer_min, day_start, day_end, sms_reminders_enabled`,
    [session.clinic_id, dayStart, dayEnd, smsEnabled]
  );
  const saved = updated.rows[0] || {};
  return res.status(200).json({
    ok: true,
    data: {
      buffer_min: Number(saved.buffer_min) || 10,
      day_start: saved.day_start,
      day_end: saved.day_end,
      sms_reminders_enabled: saved.sms_reminders_enabled !== false,
    },
  });
}

async function handlePlansGet(req, res, session) {
  const patientId = String(req.query?.patientId || req.query?.patient_id || '').trim();
  const params = [session.clinic_id];
  let sql = `
    SELECT p.id, p.patient_id, p.title, p.status, p.created_at,
           (SELECT COUNT(*)::int FROM plan_steps s WHERE s.plan_id = p.id) AS steps_total,
           (SELECT COUNT(*)::int FROM plan_steps s WHERE s.plan_id = p.id AND s.done_at IS NOT NULL) AS steps_done
    FROM treatment_plans p
    WHERE p.clinic_id = $1
  `;
  if (patientId) {
    sql += ' AND p.patient_id::text = $2';
    params.push(patientId);
  }
  sql += ' ORDER BY p.created_at DESC LIMIT 80';
  const result = await query(sql, params);
  return res.status(200).json({ ok: true, data: result.rows || [] });
}

async function handlePlanCreate(req, res, session) {
  const body = req.body ?? {};
  const patientId = String(body.patientId || body.patient_id || '').trim();
  const title = sanitizeString(body.title, 160);
  if (!patientId || !title) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'patientId and title are required'));
  }
  const patient = await getPatientForClinic(session.clinic_id, patientId);
  if (!patient) {
    return res.status(404).json(createApiError('NOT_FOUND', 'Patient introuvable'));
  }
  const inserted = await query(
    `INSERT INTO treatment_plans (clinic_id, patient_id, title, status)
     VALUES ($1, $2, $3, 'open')
     RETURNING id, patient_id, title, status, created_at`,
    [session.clinic_id, patient.id, title]
  );
  const plan = inserted.rows[0];
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const savedSteps = [];
  for (let i = 0; i < steps.length; i += 1) {
    const label = sanitizeString(steps[i]?.label || steps[i]?.title || steps[i], 160);
    if (!label) continue;
    const step = await query(
      `INSERT INTO plan_steps (plan_id, position, label, booking_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, position, label, booking_id, done_at`,
      [
        plan.id,
        Number(steps[i]?.position) || i + 1,
        label,
        UUID_RE.test(String(steps[i]?.bookingId || steps[i]?.booking_id || ''))
          ? String(steps[i].bookingId || steps[i].booking_id)
          : null,
      ]
    );
    savedSteps.push(step.rows[0]);
  }
  return res.status(201).json({ ok: true, data: { ...plan, steps: savedSteps } });
}

async function handlePlanStepPatch(req, res, session) {
  const body = req.body ?? {};
  const stepId = String(body.stepId || body.step_id || body.id || '').trim();
  if (!stepId) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'stepId is required'));
  }
  const done = body.done === true || body.done === 'true';
  const bookingId = UUID_RE.test(String(body.bookingId || body.booking_id || ''))
    ? String(body.bookingId || body.booking_id)
    : null;
  const updated = await query(
    `UPDATE plan_steps s
     SET done_at = CASE WHEN $3 THEN COALESCE(s.done_at, NOW()) ELSE NULL END,
         booking_id = COALESCE($4::uuid, s.booking_id)
     FROM treatment_plans p
     WHERE s.id::text = $1
       AND s.plan_id = p.id
       AND p.clinic_id = $2
     RETURNING s.id, s.plan_id, s.position, s.label, s.booking_id, s.done_at`,
    [stepId, session.clinic_id, done, bookingId]
  );
  if (!updated.rows[0]) {
    return res.status(404).json(createApiError('NOT_FOUND', 'Étape introuvable'));
  }
  await query(
    `UPDATE treatment_plans p
     SET status = CASE
           WHEN NOT EXISTS (SELECT 1 FROM plan_steps s WHERE s.plan_id = p.id AND s.done_at IS NULL)
                AND EXISTS (SELECT 1 FROM plan_steps s WHERE s.plan_id = p.id)
           THEN 'done' ELSE 'open' END,
         updated_at = NOW()
     WHERE p.id = $1 AND p.clinic_id = $2`,
    [updated.rows[0].plan_id, session.clinic_id]
  );
  return res.status(200).json({ ok: true, data: updated.rows[0] });
}

async function handleStockGet(res, session) {
  const result = await query(
    `SELECT id, name, qty, reorder_at, updated_at,
            (qty <= reorder_at) AS reorder
     FROM stock_items
     WHERE clinic_id = $1
     ORDER BY name ASC`,
    [session.clinic_id]
  );
  return res.status(200).json({ ok: true, data: result.rows || [] });
}

async function handleStockUpsert(req, res, session) {
  const body = req.body ?? {};
  const name = sanitizeString(body.name, 120);
  const qty = Number(body.qty);
  const reorderAt = Number(body.reorder_at ?? body.reorderAt ?? 0);
  if (!name) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'name is required'));
  }
  const inserted = await query(
    `INSERT INTO stock_items (clinic_id, name, qty, reorder_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (clinic_id, name) DO UPDATE SET
       qty = EXCLUDED.qty,
       reorder_at = EXCLUDED.reorder_at,
       updated_at = NOW()
     RETURNING id, name, qty, reorder_at, (qty <= reorder_at) AS reorder`,
    [session.clinic_id, name, Number.isFinite(qty) ? Math.max(0, Math.round(qty)) : 0, Number.isFinite(reorderAt) ? Math.max(0, Math.round(reorderAt)) : 0]
  );
  return res.status(200).json({ ok: true, data: inserted.rows[0] });
}

async function applyStockUses(clinicId, bookingId, uses) {
  const alerts = [];
  const applied = [];
  for (const use of uses || []) {
    const itemId = String(use.itemId || use.item_id || '').trim();
    const qty = Math.max(1, Math.round(Number(use.qty) || 1));
    if (!UUID_RE.test(itemId)) continue;
    const updated = await query(
      `UPDATE stock_items
       SET qty = GREATEST(qty - $3, 0), updated_at = NOW()
       WHERE clinic_id = $1 AND id::text = $2
       RETURNING id, name, qty, reorder_at`,
      [clinicId, itemId, qty]
    );
    const item = updated.rows[0];
    if (!item) continue;
    await query(
      `INSERT INTO stock_uses (clinic_id, item_id, booking_id, qty)
       VALUES ($1, $2, $3, $4)`,
      [clinicId, item.id, bookingId || null, qty]
    );
    applied.push(item);
    if (Number(item.qty) <= Number(item.reorder_at)) {
      alerts.push({ id: item.id, name: item.name, qty: item.qty, reorder_at: item.reorder_at });
    }
  }
  return { applied, alerts };
}

async function handleStockUse(req, res, session) {
  const body = req.body ?? {};
  const bookingId = UUID_RE.test(String(body.bookingId || body.booking_id || ''))
    ? String(body.bookingId || body.booking_id)
    : null;
  const uses = Array.isArray(body.uses) ? body.uses : [body];
  const result = await applyStockUses(session.clinic_id, bookingId, uses);
  return res.status(200).json({ ok: true, data: result });
}

async function handleReferral(req, res, session) {
  const body = req.body ?? {};
  const patientId = String(body.patientId || body.patient_id || '').trim();
  const toPhone = toE164MA(body.toPhone || body.to || body.phone);
  if (!patientId || !isValidMaMobileE164(toPhone)) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'patientId and a valid toPhone are required'));
  }
  const patient = await getPatientForClinic(session.clinic_id, patientId);
  if (!patient) {
    return res.status(404).json(createApiError('NOT_FOUND', 'Patient introuvable'));
  }
  const last = await query(
    `SELECT starts_at, treatment_name
     FROM bookings
     WHERE clinic_id = $1 AND patient_id = $2 AND COALESCE(booking_kind, 'visit') = 'visit'
     ORDER BY starts_at DESC
     LIMIT 1`,
    [session.clinic_id, patient.id]
  );
  const lastVisit = last.rows[0]?.starts_at
    ? new Date(last.rows[0].starts_at).toLocaleString('fr-MA', { timeZone: 'Africa/Casablanca' })
    : '';
  const bodyText = referralSms({
    name: displayNameUpper(patient.display_name),
    lastVisit,
    allergies: patient.allergies || '',
    note: sanitizeString(body.note, 280),
  });
  const sms = await dispatchSms({
    clinicId: session.clinic_id,
    purpose: 'referral',
    to: toPhone,
    body: bodyText,
    req,
    lockKey: `sms:referral:${patient.id}:${toPhone}:${new Date().toISOString().slice(0, 10)}`,
  });
  return res.status(200).json({
    ok: true,
    data: {
      skipped: Boolean(sms.skipped),
      reason: sms.reason || null,
      sid: sms.sid || null,
    },
  });
}

async function handleMembershipsGet(res, session) {
  const result = await query(
    `SELECT m.staff_id, m.clinic_id, su.display_name, su.role::text AS role, su.username
     FROM staff_clinic_memberships m
     JOIN staff_users su ON su.id = m.staff_id
     WHERE m.clinic_id = $1
     ORDER BY su.display_name ASC`,
    [session.clinic_id]
  );
  return res.status(200).json({ ok: true, data: result.rows || [] });
}

function copayFor(treatmentName, insuranceType) {
  return expectedCopayMad(treatmentName, insuranceType);
}

module.exports = {
  mapPatient,
  handlePatientGet,
  handlePatientPatch,
  handleClinicSettingsGet,
  handleClinicSettingsPatch,
  handlePlansGet,
  handlePlanCreate,
  handlePlanStepPatch,
  handleStockGet,
  handleStockUpsert,
  handleStockUse,
  applyStockUses,
  handleReferral,
  handleMembershipsGet,
  copayFor,
  ensurePatient,
};
