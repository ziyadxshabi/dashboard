/**
 * DentaFlow OS — serverless auth primitives (JWT + scrypt + rate limiting).
 * Generate password hashes: node -e "const c=require('./api/_lib/auth-crypto');console.log(c.hashPassword('your-password'))"
 */
const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DEFAULT_JWT_TTL_SEC = 8 * 60 * 60;
const LOGIN_RATE_LIMIT_MAX = 5;
const LOGIN_RATE_LIMIT_TTL_SEC = 900;
const REDIS_TIMEOUT_MS = 5000;

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

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown_ip';
}

function getClientFingerprint(req) {
  const ip = getClientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 120);
  return `${ip}|${ua}`;
}

function redisBaseUrl() {
  return String(
    process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_CONNECTION_URL || ''
  ).replace(/\/+$/, '');
}

function redisHeaders() {
  const token = String(
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || ''
  ).trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function redisPost(path) {
  const base = redisBaseUrl();
  if (!base) {
    throw new Error('UPSTASH_REDIS_REST_URL missing');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: redisHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`Redis HTTP ${response.status}`);
    }
    return response.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Distributed login rate limit via Upstash Redis INCR + EXPIRE.
 * Allows LOGIN_RATE_LIMIT_MAX attempts per IP per 15-minute window.
 * Fails open when Redis is unavailable.
 */
async function checkLoginRateLimit(req) {
  const clientIp = getClientIp(req);
  const redisKey = `ratelimit:login:${clientIp}`;

  try {
    const incrResult = await redisPost(`/incr/${encodeURIComponent(redisKey)}`);
    const count = Number(incrResult?.result);

    if (count === 1) {
      await redisPost(`/expire/${encodeURIComponent(redisKey)}/${LOGIN_RATE_LIMIT_TTL_SEC}`);
    }

    if (count > LOGIN_RATE_LIMIT_MAX) {
      let retryAfterSec = LOGIN_RATE_LIMIT_TTL_SEC;
      try {
        const ttlResult = await redisPost(`/ttl/${encodeURIComponent(redisKey)}`);
        const ttl = Number(ttlResult?.result);
        if (Number.isFinite(ttl) && ttl > 0) {
          retryAfterSec = ttl;
        }
      } catch {
        // keep default window length
      }

      return { blocked: true, retryAfterSec };
    }

    return { blocked: false, retryAfterSec: 0 };
  } catch (err) {
    console.error('[Rate Limit Bypass] Redis unavailable:', err?.message || err);
    return { blocked: false, retryAfterSec: 0, bypassed: true };
  }
}

/** No-op: attempt counting happens in checkLoginRateLimit (INCR per login request). */
async function recordLoginFailure() {
  return undefined;
}

/** Clear rate-limit counter after a successful login. */
async function resetLoginFailures(req) {
  const clientIp = getClientIp(req);
  const redisKey = `ratelimit:login:${clientIp}`;

  try {
    await redisPost(`/del/${encodeURIComponent(redisKey)}`);
  } catch (err) {
    console.error('[Rate Limit] Redis DEL failed on login success:', err?.message || err);
  }
}

function extractBearerToken(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : '';
}

const AUTH_COOKIE_NAME = 'dentaflow_session';
const AUTH_COOKIE_NAME_ASSISTANT = 'dentaflow_session_ast';
const AUTH_COOKIE_MAX_AGE_SEC = DEFAULT_JWT_TTL_SEC;

function parseCookies(req) {
  const raw = req?.headers?.cookie ?? req?.headers?.Cookie;
  if (!raw || typeof raw !== 'string') return {};

  const cookies = {};
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function setAuthCookie(res, token, cookieName = AUTH_COOKIE_NAME) {
  const value = encodeURIComponent(String(token ?? ''));
  res.setHeader(
    'Set-Cookie',
    `${cookieName}=${value}; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE_SEC}; Path=/`
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', [
    `${AUTH_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
    `${AUTH_COOKIE_NAME_ASSISTANT}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
  ]);
}

function getTokenFromRequest(req, expectedRole) {
  const cookies = parseCookies(req);

  if (expectedRole === 'assistant') {
    return cookies[AUTH_COOKIE_NAME_ASSISTANT] || null;
  }
  if (expectedRole === 'doctor') {
    return cookies[AUTH_COOKIE_NAME] || null;
  }

  const fromCookie = cookies[AUTH_COOKIE_NAME] || cookies[AUTH_COOKIE_NAME_ASSISTANT];
  if (fromCookie) return fromCookie;

  const fromBearer = extractBearerToken(req);
  return fromBearer || null;
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

  const token = getTokenFromRequest(req, options.expectedRole);
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
  getClientIp,
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginFailures,
  extractBearerToken,
  getRoleCredentials,
  applyCors,
  requireBearerSession,
  setAuthCookie,
  clearAuthCookie,
  getTokenFromRequest,
  DEFAULT_JWT_TTL_SEC,
};
