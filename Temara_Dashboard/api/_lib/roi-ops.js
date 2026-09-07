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
    allergies: row.allergies || '',
    chronic_conditions: row.chronic_conditions || '',
    preferred_anesthetic: row.preferred_anesthetic || '',
    last_xray_on: row.last_xray_on || null,
    insurance_type: row.insurance_type || null,
    insurance_label: insuranceLabel(row.insurance_type),
    sms_consent: row.sms_consent !== false,
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

  const updated = await query(
    `UPDATE patients
     SET display_name = COALESCE(NULLIF($3, ''), display_name),
         allergies = $4,
         chronic_conditions = $5,
         preferred_anesthetic = $6,
         last_xray_on = $7::date,
         insurance_type = $8,
         sms_consent = COALESCE($9, sms_consent),
         updated_at = NOW()
     WHERE clinic_id = $1 AND id = $2
     RETURNING *`,
    [
      session.clinic_id,
      existing.id,
      sanitizeString(body.display_name ?? body.displayName ?? body.name, 100),
      sanitizeString(body.allergies, 500) || null,
      sanitizeString(body.chronic_conditions ?? body.chronicConditions, 500) || null,
      sanitizeString(body.preferred_anesthetic ?? body.preferredAnesthetic, 120) || null,
      body.last_xray_on || body.lastXrayOn || null,
      insurance,
      typeof body.sms_consent === 'boolean' ? body.sms_consent : (typeof body.smsConsent === 'boolean' ? body.smsConsent : null),
    ]
  );
  return res.status(200).json({ ok: true, data: mapPatient(updated.rows[0]) });
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
