// ── GATE: API key / PIN auth (SHA-256, timing-safe, brute-force protected) ──
const crypto = require('crypto');

function timingSafeEqualStrings(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const ba = Buffer.from(sa, 'utf8');
  const bb = Buffer.from(sb, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function readAgencyAuthHeader(h) {
  const bag = h ?? {};
  for (const [key, value] of Object.entries(bag)) {
    if (key && key.toLowerCase() === 'x-agency-auth') {
      const v = String(value ?? '').trim();
      if (v) return v;
    }
  }
  return '';
}

function readCredential(item) {
  const header = readAgencyAuthHeader(item.headers ?? {});
  if (header) return header;
  const body = item.body ?? {};
  return String(body.pin ?? body.PIN ?? body.authKey ?? '').trim();
}

function stripSecrets(item) {
  const clean = { ...item };
  if (clean.body && typeof clean.body === 'object') {
    const b = { ...clean.body };
    delete b.pin;
    delete b.PIN;
    delete b.password;
    delete b.authKey;
    clean.body = b;
  }
  if (clean.headers && typeof clean.headers === 'object') {
    const h = { ...clean.headers };
    for (const key of Object.keys(h)) {
      if (key && key.toLowerCase() === 'x-agency-auth') delete h[key];
    }
    clean.headers = h;
  }
  return clean;
}

async function redisHeaders() {
  const token = String($env['REDIS_REST_TOKEN'] ?? '').trim();
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function redisBase() {
  const base = String($env['REDIS_CONNECTION_URL'] ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('CRITICAL: REDIS_CONNECTION_URL missing from environment');
  return base;
}

async function redisGet(key) {
  const base = redisBase();
  const h = await redisHeaders();
  const res = await fetch(`${base}/get/${encodeURIComponent(key)}`, { method: 'GET', headers: h });
  if (!res.ok) throw new Error(`REDIS_HTTP_FAIL: get ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function redisDel(key) {
  const base = redisBase();
  const h = await redisHeaders();
  const res = await fetch(`${base}/del/${encodeURIComponent(key)}`, { method: 'POST', headers: h });
  if (!res.ok) throw new Error(`REDIS_HTTP_FAIL: del ${res.status}`);
}

async function redisIncrFail(key, windowSec) {
  const base = redisBase();
  const h = await redisHeaders();
  const enc = encodeURIComponent(key);
  const incrRes = await fetch(`${base}/incr/${enc}`, { method: 'POST', headers: h });
  if (!incrRes.ok) throw new Error(`REDIS_HTTP_FAIL: incr ${incrRes.status}`);
  const incrData = await incrRes.json();
  const count = Number(incrData.result ?? 0);
  if (count === 1) {
    await fetch(`${base}/expire/${enc}/${windowSec}`, { method: 'POST', headers: h });
  }
  return count;
}

async function redisIncrWindow(key, windowSec, max) {
  const count = await redisIncrFail(key, windowSec);
  if (count > max) {
    throw new Error(`RATE_LIMIT: ${count} requests in ${windowSec}s window (max ${max})`);
  }
  return count;
}

function resolveExpectedHash() {
  const fromEnv = String($env['DASHBOARD_AUTH_KEY_SHA256'] ?? '').trim().toLowerCase();
  if (fromEnv) return fromEnv;
  const plain = String($env['DASHBOARD_AUTH_KEY'] ?? '').trim();
  if (!plain) return '';
  return sha256Hex(plain);
}

return (async () => {
  const rawItem = $input.first().json ?? {};
  const headers = rawItem.headers ?? {};

  const fwd = headers['x-forwarded-for'] ?? headers['X-Forwarded-For'] ?? '';
  const clientIp = String(fwd).split(',')[0].trim() || 'unknown';
  const clinicId = String($env['CLINIC_ID'] ?? 'temara').trim();
  const bruteKey = `authfail:dashboard:${clinicId}:${clientIp}`;

  const failCount = Number(await redisGet(bruteKey) ?? 0);
  if (failCount >= 5) {
    throw new Error('RATE_LIMIT: Brute-force protection — maximum 5 failed attempts in 15 minutes');
  }

  const expectedHash = resolveExpectedHash();
  if (!expectedHash) {
    throw new Error('AUTH_FAIL: DASHBOARD_AUTH_KEY is not configured');
  }

  const credential = readCredential(rawItem);
  if (!credential) {
    await redisIncrFail(bruteKey, 900);
    throw new Error('AUTH_FAIL: Invalid or missing credentials');
  }

  const incomingHash = sha256Hex(credential);
  if (!timingSafeEqualStrings(incomingHash, expectedHash)) {
    await redisIncrFail(bruteKey, 900);
    throw new Error('AUTH_FAIL: Invalid or missing credentials');
  }

  await redisDel(bruteKey);
  await redisIncrWindow(`ratelimit:dashboard:${clientIp}`, 300, 30);
  stripSecrets(rawItem);

  const CACHE_KEY = 'dashboard:kpi:payload';
  const cachedRaw = await redisGet(CACHE_KEY);
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      return [{
        json: {
          _fromCache: true,
          _cacheAgeMs: 0,
          ...parsed,
        },
      }];
    } catch {
      // corrupt cache — fall through
    }
  }

  return [{ json: { _fromCache: false } }];
})();
