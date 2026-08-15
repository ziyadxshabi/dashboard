/**
 * Lightweight Redis cache via Upstash REST (Vercel serverless).
 * Missing env or any failure = silent miss; never throws.
 */
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisFetch(command, ...args) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([command, ...args]),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result;
  } catch {
    return null;
  }
}

async function cacheGet(key) {
  const val = await redisFetch('GET', key);
  if (!val) return null;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds = 60) {
  await redisFetch('SET', key, JSON.stringify(value), 'EX', String(ttlSeconds));
}

function cacheKey(prefix, req) {
  const role = req.dfAuthRole || 'anonymous';
  const rawUrl = String(req.url || '');
  const qs = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
  return `${prefix}:${role}:${qs || 'default'}`;
}

module.exports = {
  cacheGet,
  cacheSet,
  cacheKey,
};
