/**
 * Liveness probe — confirms the serverless function can reach PostgreSQL.
 * Never returns DATABASE_URL, pool stats, or other secrets.
 */
'use strict';

const { query } = require('./_lib/db');
const { createApiError } = require('./_lib/validation');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json(createApiError('METHOD_NOT_ALLOWED'));
  }

  const timestamp = new Date().toISOString();

  try {
    await query('SELECT 1');
    return res.status(200).json({
      ok: true,
      status: 'healthy',
      database: 'connected',
      timestamp,
    });
  } catch {
    return res.status(503).json({
      ok: false,
      status: 'degraded',
      database: 'disconnected',
      timestamp,
    });
  }
};
