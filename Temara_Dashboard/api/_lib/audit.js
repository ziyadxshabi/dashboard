'use strict';

const { query } = require('./db');
const { UUID_RE } = require('./validation');

async function writeAudit(session, { action, entity, entityId } = {}) {
  const clinicId = session && session.clinic_id;
  if (!clinicId || !UUID_RE.test(String(clinicId))) return null;
  const staffRaw = session.sub || session.staff_id || session.user_id;
  const staffId = UUID_RE.test(String(staffRaw || '')) ? String(staffRaw) : null;
  try {
    const result = await query(
      `INSERT INTO audit_events (clinic_id, staff_id, action, entity, entity_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        clinicId,
        staffId,
        String(action || '').slice(0, 64),
        String(entity || '').slice(0, 64),
        entityId && UUID_RE.test(String(entityId)) ? String(entityId) : null,
      ]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('[audit]', err && err.message ? err.message : err);
    return null;
  }
}

module.exports = { writeAudit };
