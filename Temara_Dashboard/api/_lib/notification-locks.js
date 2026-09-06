'use strict';

const { query } = require('./db');

const DEFAULT_TTL_SEC = 86400;

async function tryAcquireLock(lockKey, ttlSec = DEFAULT_TTL_SEC) {
  const key = String(lockKey || '').trim();
  if (!key) {
    return { acquired: true, duplicate: false, error: null };
  }
  const ttl = Number.isFinite(Number(ttlSec)) && Number(ttlSec) > 0 ? Math.round(Number(ttlSec)) : DEFAULT_TTL_SEC;

  try {
    const result = await query(
      `INSERT INTO notification_locks (lock_key, expires_at, hit_count)
       VALUES ($1, NOW() + make_interval(secs => $2), 1)
       ON CONFLICT (lock_key) DO UPDATE
         SET expires_at = EXCLUDED.expires_at,
             hit_count = 1,
             created_at = NOW()
       WHERE notification_locks.expires_at < NOW()
       RETURNING lock_key`,
      [key, ttl]
    );
    if (result.rows[0]?.lock_key) {
      return { acquired: true, duplicate: false, error: null };
    }
    return { acquired: false, duplicate: true, error: null };
  } catch (err) {
    return { acquired: false, duplicate: false, error: err };
  }
}

async function incrementRateLimit(rateKey, max, windowSec) {
  const key = String(rateKey || '').trim();
  if (!key) return { ok: true, blocked: false, count: 0, error: null };

  const window = Number(windowSec) > 0 ? Math.round(Number(windowSec)) : 60;
  const cap = Number(max) > 0 ? Math.round(Number(max)) : 5;

  try {
    const result = await query(
      `INSERT INTO notification_locks (lock_key, expires_at, hit_count)
       VALUES ($1, NOW() + make_interval(secs => $2), 1)
       ON CONFLICT (lock_key) DO UPDATE
         SET hit_count = CASE
               WHEN notification_locks.expires_at < NOW() THEN 1
               ELSE notification_locks.hit_count + 1
             END,
             expires_at = CASE
               WHEN notification_locks.expires_at < NOW() THEN EXCLUDED.expires_at
               ELSE notification_locks.expires_at
             END,
             created_at = CASE
               WHEN notification_locks.expires_at < NOW() THEN NOW()
               ELSE notification_locks.created_at
             END
       RETURNING hit_count`,
      [key, window]
    );
    const count = Number(result.rows[0]?.hit_count || 0);
    return { ok: true, blocked: count > cap, count, error: null };
  } catch (err) {
    return { ok: false, blocked: false, count: 0, error: err };
  }
}

module.exports = {
  DEFAULT_TTL_SEC,
  tryAcquireLock,
  incrementRateLimit,
};
