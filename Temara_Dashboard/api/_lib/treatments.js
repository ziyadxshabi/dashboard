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
  return TREATMENTS.map((item) => ({ name: item.name, duration_min: item.duration_min }));
}

function resolveTreatment(raw) {
  const key = foldKey(raw);
  if (!key) return null;
  return BY_KEY.get(key) || null;
}

module.exports = {
  TREATMENTS,
  listTreatments,
  resolveTreatment,
};
