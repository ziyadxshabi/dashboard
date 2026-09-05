/**
 * Bulk SMS — clinic-scoped dispatch audit (no n8n).
 * Auth: dentaflow_session cookie. Roles: doctor | assistant.
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
} = require('./_lib/validation');

const ENSURE_AUDIT_SQL = `
  CREATE TABLE IF NOT EXISTS sms_dispatch_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_users(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    recipient_count INT NOT NULL,
    recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
  )
`;

const INSERT_AUDIT_SQL = `
  INSERT INTO sms_dispatch_log (clinic_id, staff_id, message, recipient_count, recipients)
  VALUES ($1, $2, $3, $4, $5::jsonb)
  RETURNING id, created_at
`;

let schemaReady = false;

async function ensureAuditTable() {
  if (schemaReady) return;
  await query(ENSURE_AUDIT_SQL);
  schemaReady = true;
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

  const parsed = validateBulkSmsInput(req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  const { message, recipients } = parsed.value;
  const sanitized = sanitizeString(message, 500);

  try {
    await ensureAuditTable();
    await query(INSERT_AUDIT_SQL, [
      session.clinic_id,
      session.sub || null,
      sanitized,
      recipients.length,
      JSON.stringify(recipients),
    ]);

    return res.status(200).json({
      ok: true,
      dispatchedCount: recipients.length,
      message: sanitized,
    });
  } catch (err) {
    return sendDbError(res, err);
  }
};
