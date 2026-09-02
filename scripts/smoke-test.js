/**
 * DentaFlow OS — production smoke tests for the Vercel API layer.
 * Zero dependencies. Requires Node.js 18+ (global fetch).
 *
 * Usage:
 *   node scripts/smoke-test.js
 *   node scripts/smoke-test.js https://your-app.vercel.app
 *   TARGET_URL=https://your-app.vercel.app DOCTOR_USERNAME=xxx DOCTOR_PASSWORD=xxx node scripts/smoke-test.js
 */
'use strict';

const SESSION_COOKIE = 'dentaflow_session';
const SESSION_COOKIE_ASST = 'dentaflow_session_ast';
const REQUEST_TIMEOUT_MS = 15_000;

const FALLBACK_DOCTOR_USER = 'docteur';
const FALLBACK_DOCTOR_PASS = 'test-password';
const FALLBACK_ASSISTANT_USER = 'assistante';
const FALLBACK_ASSISTANT_PASS = 'test-password';

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function loadConfig() {
  const positional = String(process.argv[2] || '').trim();
  const positionalUrl = positional && !positional.startsWith('--') ? positional : '';

  return {
    targetUrl: firstNonEmpty(
      process.env.TARGET_URL,
      positionalUrl,
      process.env.SMOKE_TEST_URL,
      process.env.BASE_URL,
      'http://localhost:3000'
    ).replace(/\/+$/, ''),
    doctorUser: firstNonEmpty(process.env.DOCTOR_USERNAME, FALLBACK_DOCTOR_USER),
    doctorPass: firstNonEmpty(process.env.DOCTOR_PASSWORD, FALLBACK_DOCTOR_PASS),
    assistantUser: firstNonEmpty(process.env.ASSISTANT_USERNAME, FALLBACK_ASSISTANT_USER),
    assistantPass: firstNonEmpty(process.env.ASSISTANT_PASSWORD, FALLBACK_ASSISTANT_PASS),
  };
}

function cookieHeader(jar) {
  return Object.entries(jar || {})
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function collectSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function applySetCookieToJar(jar, headers) {
  const next = { ...jar };
  const lines = collectSetCookieHeaders(headers);
  for (const line of lines) {
    const parts = String(line || '').split(';').map((part) => part.trim());
    const pair = parts[0] || '';
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const attrs = parts.slice(1).join(';').toLowerCase();
    const expired = /max-age=0\b/.test(attrs) || /expires=thu, 01 jan 1970/i.test(attrs);
    if (expired || value === '') {
      delete next[name];
    } else {
      next[name] = value;
    }
  }
  return next;
}

function cookieCleared(headers) {
  const lines = collectSetCookieHeaders(headers);
  if (!lines.length) return false;
  return lines.some((line) => {
    const lower = String(line).toLowerCase();
    const name = String(line).split('=')[0].trim();
    const isSession = name === SESSION_COOKIE || name === SESSION_COOKIE_ASST;
    return isSession && (/max-age=0\b/.test(lower) || /=\s*;/.test(String(line)));
  });
}

class CookieJar {
  constructor() {
    this.store = {};
  }

  header() {
    return cookieHeader(this.store);
  }

  ingest(headers) {
    this.store = applySetCookieToJar(this.store, headers);
    return this.store;
  }

  hasSession() {
    return Boolean(this.store[SESSION_COOKIE] || this.store[SESSION_COOKIE_ASST]);
  }
}

async function request(targetUrl, method, pathname, { body, jar } = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('This script requires Node.js 18+ (global fetch).');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  const headers = { Accept: 'application/json' };
  const cookie = jar ? jar.header() : '';
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(`${targetUrl}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'follow',
      signal: controller.signal,
    });

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (jar) jar.ingest(response.headers);

    return {
      status: response.status,
      json,
      text,
      headers: response.headers,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(err?.message || String(err));
  } finally {
    clearTimeout(timer);
  }
}

function bodyCode(res) {
  return res.json && typeof res.json === 'object' ? res.json.code : undefined;
}

function hasCode(res, expected) {
  return bodyCode(res) === expected;
}

function unauthorizedShape(res) {
  if (res.status !== 401) return false;
  if (hasCode(res, 'UNAUTHORIZED')) return true;
  const error = String(res.json?.error || '');
  return /unauthorized/i.test(error);
}

const MARK_PASS = '✔ PASS';
const MARK_FAIL = '✖ FAIL';

function printResult(index, name, result) {
  const mark = result.ok ? MARK_PASS : MARK_FAIL;
  const latency = Number.isFinite(result.latencyMs) ? `${result.latencyMs}ms` : '—';
  const status = result.status != null ? `HTTP ${result.status}` : 'no-response';
  const detail = result.detail ? ` — ${result.detail}` : '';
  console.log(`${mark}  ${index}. ${name}  [${status}, ${latency}]${detail}`);
}

async function runOne(index, name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    result.latencyMs = result.latencyMs != null ? result.latencyMs : Date.now() - started;
    printResult(index, name, result);
    return result;
  } catch (err) {
    const result = {
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      detail: err?.message || String(err),
    };
    printResult(index, name, result);
    return result;
  }
}

async function testHealth(cfg) {
  const res = await request(cfg.targetUrl, 'GET', '/api/health');
  const payload = res.json && typeof res.json === 'object' ? res.json : null;
  const httpOk = res.status === 200 || res.status === 503;
  const hasStatus = typeof payload?.status === 'string';
  const hasServices = payload?.services != null && typeof payload.services === 'object';
  if (httpOk && hasStatus && hasServices) {
    return {
      ok: true,
      status: res.status,
      latencyMs: res.latencyMs,
      detail: `status=${payload.status}, services=${Object.keys(payload.services).join(',')}`,
    };
  }
  return {
    ok: false,
    status: res.status,
    latencyMs: res.latencyMs,
    detail: `expected 200/503 with status+services, got status=${payload?.status} services=${typeof payload?.services} body=${(res.text || '').slice(0, 160)}`,
  };
}

async function testMethodGuard(cfg) {
  const res = await request(cfg.targetUrl, 'POST', '/api/dashboard-data', { body: {} });
  const ok = res.status === 405 && hasCode(res, 'METHOD_NOT_ALLOWED');
  return {
    ok,
    status: res.status,
    latencyMs: res.latencyMs,
    detail: ok ? `code=${bodyCode(res)}` : `expected 405 METHOD_NOT_ALLOWED, got code=${bodyCode(res)} body=${(res.text || '').slice(0, 160)}`,
  };
}

async function testUnauthenticatedRoster(cfg) {
  const res = await request(cfg.targetUrl, 'GET', '/api/roster');
  const ok = unauthorizedShape(res);
  return {
    ok,
    status: res.status,
    latencyMs: res.latencyMs,
    detail: ok
      ? `code=${bodyCode(res) || 'UNAUTHORIZED'}`
      : `expected 401 UNAUTHORIZED, got code=${bodyCode(res)} body=${(res.text || '').slice(0, 160)}`,
  };
}

async function testUpdateStatusValidation(cfg, jar) {
  const loginRes = await request(cfg.targetUrl, 'POST', '/api/auth', {
    jar,
    body: { role: 'doctor', username: cfg.doctorUser, password: cfg.doctorPass },
  });
  if (loginRes.status !== 200 || !jar.hasSession()) {
    return {
      ok: false,
      status: loginRes.status,
      latencyMs: loginRes.latencyMs,
      detail: `could not establish session for validation test (HTTP ${loginRes.status})`,
    };
  }

  const res = await request(cfg.targetUrl, 'POST', '/api/update-status', {
    jar,
    body: { bookingId: '', newStatus: 'not-a-status' },
  });
  const ok = res.status === 400 && hasCode(res, 'VALIDATION_ERROR');
  return {
    ok,
    status: res.status,
    latencyMs: res.latencyMs,
    detail: ok ? `code=${bodyCode(res)}` : `expected 400 VALIDATION_ERROR, got code=${bodyCode(res)} body=${(res.text || '').slice(0, 160)}`,
  };
}

async function testLeadCaptureValidation(cfg) {
  const res = await request(cfg.targetUrl, 'POST', '/api/lead-capture', {
    body: { nom: 'A', telephone: '0612345678' },
  });
  const ok = res.status === 400 && hasCode(res, 'VALIDATION_ERROR');
  return {
    ok,
    status: res.status,
    latencyMs: res.latencyMs,
    detail: ok ? `code=${bodyCode(res)}` : `expected 400 VALIDATION_ERROR, got code=${bodyCode(res)} body=${(res.text || '').slice(0, 160)}`,
  };
}

async function testDoctorAuth(cfg, jar) {
  const res = await request(cfg.targetUrl, 'POST', '/api/auth', {
    jar,
    body: { role: 'doctor', username: cfg.doctorUser, password: cfg.doctorPass },
  });
  const role = res.json?.role;
  const cookieOk = jar.hasSession();
  const ok = res.status === 200 && res.json?.ok === true && role === 'doctor' && cookieOk;
  return {
    ok,
    status: res.status,
    latencyMs: res.latencyMs,
    detail: ok
      ? `role=${role}, cookie=${SESSION_COOKIE}`
      : `expected role=doctor + Set-Cookie, got role=${role} cookie=${cookieOk} body=${(res.text || '').slice(0, 160)}`,
  };
}

async function testAuthenticatedRoster(cfg, jar) {
  const res = await request(cfg.targetUrl, 'GET', '/api/roster', { jar });
  const ok = res.status === 200 && res.json?.ok === true;
  const rows = Array.isArray(res.json?.data) ? res.json.data.length : '?';
  return {
    ok,
    status: res.status,
    latencyMs: res.latencyMs,
    detail: ok ? `ok=true, rows=${rows}` : `expected HTTP 200, body=${(res.text || '').slice(0, 160)}`,
  };
}

async function testAuthenticatedWaitlist(cfg, jar) {
  const res = await request(cfg.targetUrl, 'GET', '/api/waitlist', { jar });
  const ok = res.status === 200 && res.json?.ok === true;
  const rows = Array.isArray(res.json?.data) ? res.json.data.length : '?';
  return {
    ok,
    status: res.status,
    latencyMs: res.latencyMs,
    detail: ok ? `ok=true, rows=${rows}` : `expected HTTP 200, body=${(res.text || '').slice(0, 160)}`,
  };
}

async function testLogout(cfg, jar) {
  const res = await request(cfg.targetUrl, 'POST', '/api/auth/logout', {
    jar,
    body: {},
  });
  const cleared = cookieCleared(res.headers) || !jar.hasSession();
  const ok = res.status === 200 && (res.json?.ok === true || res.json?.ok === undefined) && cleared;
  return {
    ok,
    status: res.status,
    latencyMs: res.latencyMs,
    detail: ok
      ? 'session cookie cleared (Max-Age=0)'
      : `expected HTTP 200 + cleared Set-Cookie, cleared=${cleared} body=${(res.text || '').slice(0, 160)}`,
  };
}

async function main() {
  const cfg = loadConfig();
  const jar = new CookieJar();

  console.log('');
  console.log(`DentaFlow OS smoke test`);
  console.log(`Target: ${cfg.targetUrl}`);
  console.log(`Doctor: ${cfg.doctorUser}  |  Assistant fallback: ${cfg.assistantUser}`);
  console.log('─'.repeat(64));

  const results = [];

  results.push(await runOne(1, 'GET /api/health', () => testHealth(cfg)));
  results.push(await runOne(2, 'POST /api/dashboard-data method guard', () => testMethodGuard(cfg)));
  results.push(await runOne(3, 'GET /api/roster unauthenticated', () => testUnauthenticatedRoster(cfg)));
  results.push(await runOne(4, 'POST /api/update-status validation', () => testUpdateStatusValidation(cfg, jar)));
  results.push(await runOne(5, 'POST /api/lead-capture validation', () => testLeadCaptureValidation(cfg)));
  results.push(await runOne(6, 'POST /api/auth doctor login', () => testDoctorAuth(cfg, jar)));
  results.push(await runOne(7, 'GET /api/roster authenticated', () => testAuthenticatedRoster(cfg, jar)));
  results.push(await runOne(8, 'GET /api/waitlist authenticated', () => testAuthenticatedWaitlist(cfg, jar)));
  results.push(await runOne(9, 'POST /api/auth/logout', () => testLogout(cfg, jar)));

  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;

  console.log('─'.repeat(64));
  console.log(`Summary  Total: ${total}  Passed: ${passed}  Failed: ${failed}`);
  console.log('');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`✖ FAIL  runner crashed — ${err?.message || err}`);
  console.log('Summary  Total: 0  Passed: 0  Failed: 1');
  process.exit(1);
});
