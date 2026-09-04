/**
 * Public web lead capture — inserts an active waitlist row scoped by clinic slug.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const { createApiError, sendDbError, validatePhone } = require('./_lib/validation');

const DEFAULT_CLINIC_SLUG = 'temara';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CLINIC_LOOKUP_SQL = `
  SELECT id FROM clinics WHERE slug = $1 LIMIT 1
`;

const WAITLIST_LEAD_INSERT_SQL = `
  INSERT INTO waitlist (clinic_id, patient_name, patient_phone, priority, notes, status)
  VALUES ($1, $2, $3, 'Moyenne', 'Lead Web Capture', 'active')
  RETURNING id
`;

function sanitizeClinicSlug(raw) {
  const slug = String(raw ?? '').trim().toLowerCase();
  if (!slug) return DEFAULT_CLINIC_SLUG;
  if (!SLUG_RE.test(slug) || slug.length > 64) return null;
  return slug;
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

  const body = req.body ?? {};
  const nom = String(body.nom ?? body.name ?? '').trim();
  const telephoneRaw = String(body.telephone ?? body.phone ?? '').trim();
  const clinicSlug = sanitizeClinicSlug(body.clinicSlug ?? body.clinic_slug ?? body.slug);

  if (!clinicSlug) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'clinicSlug invalide'));
  }

  if (nom.length < 2) {
    return res.status(400).json(createApiError('VALIDATION_ERROR', 'nom is required (min 2 characters)'));
  }

  const phoneResult = validatePhone(telephoneRaw);
  if (!phoneResult.ok) {
    return res.status(400).json(phoneResult.error);
  }

  try {
    const clinicResult = await query(CLINIC_LOOKUP_SQL, [clinicSlug]);
    const clinicId = clinicResult.rows?.[0]?.id;
    if (!clinicId) {
      return res.status(404).json(createApiError('NOT_FOUND', 'Clinic not found'));
    }

    await query(WAITLIST_LEAD_INSERT_SQL, [clinicId, nom, phoneResult.value]);

    return res.status(200).json({
      ok: true,
      message: 'Demande enregistrée avec succès',
    });
  } catch (err) {
    return sendDbError(res, err);
  }
};
