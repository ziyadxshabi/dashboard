/**
 * Fill-gap — clinic-scoped waitlist candidates from PostgreSQL.
 * Optionally fans out to N8N_WEBHOOK_FILL_GAP without blocking the response.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const {
  createApiError,
  requireClinicSession,
  sendDbError,
  validateFillGapInput,
} = require('./_lib/validation');

const FILL_GAP_CANDIDATES_SQL = `
  SELECT id, patient_name, patient_phone, priority
  FROM waitlist
  WHERE clinic_id = $1 AND status = 'active'
  ORDER BY CASE priority
    WHEN 'Urgent' THEN 1
    WHEN 'Haute' THEN 2
    WHEN 'Moyenne' THEN 3
    ELSE 4
  END, created_at ASC
  LIMIT 10
`;

function enqueueFillGapWebhook(payload) {
  const webhookUrl = String(process.env.N8N_WEBHOOK_FILL_GAP || '').trim();
  if (!webhookUrl) return;

  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
    'user-agent': 'DentaFlow-FillGap/1.0',
  };
  if (authKey) headers['x-agency-auth'] = authKey;

  void fetch(webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.error('[fill-gap] SMS webhook failed:', err?.message || err);
  });
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

  const session = requireClinicSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
  if (!session) return;

  const parsed = validateFillGapInput(req.body ?? {});
  if (!parsed.ok) {
    return res.status(400).json(parsed.error);
  }

  const { slotDate, slotTime, reason } = parsed.value;

  try {
    const result = await query(FILL_GAP_CANDIDATES_SQL, [session.clinic_id]);
    const candidates = result.rows || [];

    enqueueFillGapWebhook({
      clinic_id: session.clinic_id,
      slotDate,
      slotTime,
      reason,
      candidates,
    });

    return res.status(200).json({ ok: true, slotDate, slotTime, candidates });
  } catch (err) {
    return sendDbError(res, err);
  }
};
