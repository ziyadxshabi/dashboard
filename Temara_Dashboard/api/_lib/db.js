/**
 * DentaFlow OS — parameterized PostgreSQL access for Vercel serverless handlers.
 * Requires DATABASE_URL. All queries MUST pass bound parameters (no string concat).
 */
'use strict';

const { Pool } = require('pg');

let pool;

function isLocalConnection(connectionString) {
  try {
    const host = new URL(connectionString).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return /localhost|127\.0\.0\.1/.test(String(connectionString || ''));
  }
}

function getPool() {
  if (pool) return pool;

  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    const err = new Error('DATABASE_URL is not configured');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }

  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    // Local Postgres has no TLS; Supabase pooler requires SSL.
    ssl: isLocalConnection(connectionString) ? false : { rejectUnauthorized: false },
  });

  return pool;
}

async function query(text, params = []) {
  const result = await getPool().query(text, params);
  return result;
}

function withClinic(clinicId) {
  return {
    clinicId,
    query: (sql, params) => query(sql, params),
    scoped: (sql, extraParams = []) => query(sql, [clinicId, ...extraParams]),
  };
}

module.exports = {
  query,
  getPool,
  withClinic,
};
