// Shared Upstash Redis REST helpers for n8n Code nodes.
// Env: REDIS_CONNECTION_URL, REDIS_REST_TOKEN

const REDIS_TIMEOUT_MS = 5000;

async function redisSetNx(key, ttlSec) {
  const base = String($env['REDIS_CONNECTION_URL'] ?? '').replace(/\/+$/, '');
  const token = String($env['REDIS_REST_TOKEN'] ?? '').trim();
  if (!base) {
    return { ok: false, redisError: 'REDIS_CONNECTION_URL missing', acquired: false };
  }
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${base}/set/${encodeURIComponent(key)}/1?NX=true&EX=${ttlSec}`,
      { method: 'POST', headers, signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, redisError: `REDIS_HTTP_${res.status}`, acquired: false };
    }
    const data = await res.json();
    return { ok: true, redisError: null, acquired: data.result === 'OK' };
  } catch (e) {
    clearTimeout(timer);
    const msg = e?.name === 'AbortError' ? 'REDIS_TIMEOUT' : String(e?.message ?? e);
    return { ok: false, redisError: msg, acquired: false };
  }
}
