/**
 * Doctor dashboard KPIs — clinic-scoped aggregations on today's bookings.
 * Auth: dentaflow_session cookie → clinic_id.
 */
'use strict';

const { applyCors } = require('./_lib/auth-crypto');
const { query } = require('./_lib/db');
const { createApiError, requireClinicSession, sendDbError } = require('./_lib/validation');

const DASHBOARD_KPI_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status::text NOT IN ('Annule', 'Annulé'))::int AS patients_today,
    COUNT(*) FILTER (
      WHERE status::text IN (
        'Confirme',
        'Confirmé',
        'En salle d''attente',
        'En soin',
        'Termine',
        'Terminé'
      )
    )::int AS accepted_plans,
    COUNT(*) FILTER (WHERE status::text = 'En attente')::int AS pending_plans,
    COUNT(*) FILTER (WHERE status::text IN ('No-show', 'No-Show'))::int AS no_shows
  FROM bookings
  WHERE clinic_id = $1
    AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
`;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'GET, OPTIONS');

  if (req.method !== 'GET') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const session = requireClinicSession(req, res, { allowedRoles: ['doctor', 'assistant'] });
  if (!session) return;

  try {
    const result = await query(DASHBOARD_KPI_SQL, [session.clinic_id]);
    const row = result.rows[0] || {};
    return res.status(200).json({
      ok: true,
      data: {
        patients_today: Number(row.patients_today) || 0,
        accepted_plans: Number(row.accepted_plans) || 0,
        pending_plans: Number(row.pending_plans) || 0,
        no_shows: Number(row.no_shows) || 0,
      },
    });
  } catch (err) {
    return sendDbError(res, err);
  }
};
