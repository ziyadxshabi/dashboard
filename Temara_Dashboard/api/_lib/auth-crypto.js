/**
 * DentaFlow OS — serverless auth primitives (JWT + scrypt + rate limiting).
 * Generate password hashes: node -e "const c=require('./api/_lib/auth-crypto');console.log(c.hashPassword('your-password'))"
 */
const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DEFAULT_JWT_TTL_SEC = 8 * 60 * 60;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'base64');
    expected = Buffer.from(parts[2], 'base64');
  } catch {
    return false;
  }

  const actual = crypto.scryptSync(String(password), salt, 64, SCRYPT_PARAMS);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function signJwt(payload, secret, ttlSec = DEFAULT_JWT_TTL_SEC) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedBody = base64url(JSON.stringify(body));
  const data = `${encodedHeader}.${encodedBody}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedBody, signature] = parts;
  const data = `${encodedHeader}.${encodedBody}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');

  let sigBuf;
  let expectedBuf;
  try {
    sigBuf = Buffer.from(signature, 'base64url');
    expectedBuf = Buffer.from(expectedSig, 'base64url');
  } catch {
    return null;
  }

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

function getClientFingerprint(req) {
  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  const ip = String(forwarded || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  const ua = String(req.headers['user-agent'] || '').slice(0, 120);
  return `${ip}|${ua}`;
}

function getLoginRateState(fingerprint) {
  if (!global._dentaflowLoginRate) {
    global._dentaflowLoginRate = new Map();
  }

  const now = Date.now();
  const map = global._dentaflowLoginRate;

  for (const [key, entry] of map.entries()) {
    if (entry.lockUntil && entry.lockUntil < now - LOGIN_LOCKOUT_MS) {
      map.delete(key);
    }
  }

  let entry = map.get(fingerprint);
  if (!entry) {
    entry = { fails: 0, windowStart: now, lockUntil: 0 };
    map.set(fingerprint, entry);
  }

  if (entry.lockUntil > now) {
    return {
      blocked: true,
      retryAfterSec: Math.ceil((entry.lockUntil - now) / 1000),
      entry,
    };
  }

  if (now - entry.windowStart > LOGIN_WINDOW_MS) {
    entry.fails = 0;
    entry.windowStart = now;
  }

  return { blocked: false, retryAfterSec: 0, entry };
}

function recordLoginFailure(entry) {
  entry.fails += 1;
  if (entry.fails >= MAX_LOGIN_FAILURES) {
    entry.lockUntil = Date.now() + LOGIN_LOCKOUT_MS;
    entry.fails = 0;
  }
}

function resetLoginFailures(entry) {
  entry.fails = 0;
  entry.lockUntil = 0;
  entry.windowStart = Date.now();
}

function extractBearerToken(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : '';
}

function getRoleCredentials(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'doctor') {
    return {
      username: process.env.DOCTOR_USERNAME,
      passwordHash: process.env.DOCTOR_PASSWORD_HASH,
    };
  }
  if (normalized === 'assistant') {
    return {
      username: process.env.ASSISTANT_USERNAME,
      passwordHash: process.env.ASSISTANT_PASSWORD_HASH,
    };
  }
  return { username: null, passwordHash: null };
}

function applyCors(res, methods, allowHeaders = 'Content-Type, Accept, Authorization') {
  const origin = String(process.env.VERCEL_FRONTEND_URL || '').trim();
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', allowHeaders);
}

function requireBearerSession(req, res, options = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(503).json({ ok: false, error: 'Auth not configured' });
    return null;
  }

  const token = extractBearerToken(req);
  const payload = verifyJwt(token, secret);
  if (!payload?.role) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return null;
  }

  const allowedRoles = options.allowedRoles;
  if (Array.isArray(allowedRoles) && allowedRoles.length && !allowedRoles.includes(payload.role)) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return null;
  }

  return payload;
}

module.exports = {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  getClientFingerprint,
  getLoginRateState,
  recordLoginFailure,
  resetLoginFailures,
  extractBearerToken,
  getRoleCredentials,
  applyCors,
  requireBearerSession,
  DEFAULT_JWT_TTL_SEC,
};
