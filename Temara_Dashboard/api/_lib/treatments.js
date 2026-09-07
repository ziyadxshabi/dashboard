/**
 * Temara treatment catalog — names + durations. No extra table.
 * Staff POST /api/roster rejects unknown names; GET ?catalog=1 feeds the UI select.
 */
'use strict';

const TREATMENTS = Object.freeze([
  { name: 'Consultation', duration_min: 20, aliases: ['Controle', 'Contrôle', 'Control', 'Consult'] },
  { name: 'Détartrage', duration_min: 30, aliases: ['Detartrage', 'Détartrage'] },
  { name: 'Soin', duration_min: 40, aliases: ['Carie', 'Composite'] },
  { name: 'Extraction', duration_min: 30, aliases: [] },
  { name: 'Dévitalisation', duration_min: 60, aliases: ['Endo', 'Devitalisation'] },
  { name: 'Couronne', duration_min: 45, aliases: [] },
  { name: 'Blanchiment', duration_min: 45, aliases: [] },
  { name: 'Urgence', duration_min: 20, aliases: ['Urgences'] },
]);

/** ANAM-style reference tariffs (MAD). Display remainder only — never a slip. */
const ANAM_TARIFF_MAD = Object.freeze({
  Consultation: 150,
  'Détartrage': 250,
  Soin: 400,
  Extraction: 350,
  'Dévitalisation': 800,
  Couronne: 2500,
  Blanchiment: 1500,
  Urgence: 200,
});

const PATIENT_SHARE = Object.freeze({
  none: 1,
  prive: 1,
  cnss: 0.3,
  cnops: 0.2,
});

const INSURANCE_LABELS = Object.freeze({
  none: 'Aucun',
  prive: 'Privé',
  cnss: 'CNSS',
  cnops: 'CNOPS',
});

function foldKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const BY_KEY = new Map();
for (const item of TREATMENTS) {
  BY_KEY.set(foldKey(item.name), item);
  for (const alias of item.aliases || []) {
    BY_KEY.set(foldKey(alias), item);
  }
}

function listTreatments() {
  return TREATMENTS.map((item) => ({
    name: item.name,
    duration_min: item.duration_min,
    tariff_mad: ANAM_TARIFF_MAD[item.name] || null,
  }));
}

function resolveTreatment(raw) {
  const key = foldKey(raw);
  if (!key) return null;
  return BY_KEY.get(key) || null;
}

function insuranceLabel(type) {
  const key = String(type || '').trim().toLowerCase();
  return INSURANCE_LABELS[key] || '';
}

function expectedCopayMad(treatmentName, insuranceType) {
  const shareKey = String(insuranceType || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PATIENT_SHARE, shareKey)) return null;
  const item = resolveTreatment(treatmentName);
  const tariff = ANAM_TARIFF_MAD[item?.name || treatmentName];
  if (!Number.isFinite(tariff)) return null;
  return Math.round(tariff * PATIENT_SHARE[shareKey]);
}

module.exports = {
  TREATMENTS,
  ANAM_TARIFF_MAD,
  listTreatments,
  resolveTreatment,
  expectedCopayMad,
  insuranceLabel,
};
