// Usage: BASE_URL=https://your-app.vercel.app DOCTOR_USERNAME=xxx DOCTOR_PASSWORD=xxx ASSISTANT_USERNAME=xxx ASSISTANT_PASSWORD=xxx node scripts/smoke-test.js
// Also:  SMOKE_TEST_URL=https://your-app.vercel.app node scripts/smoke-test.js --doctor-user=xxx --doctor-pass=xxx --assistant-user=xxx --assistant-pass=xxx
'use strict';

const SESSION_COOKIE = 'dentaflow_session';
const REQUEST_TIMEOUT_MS = 15_000;
const WAITLIST_TEST_BODY = {
  nom: 'Test Patient',
  telephone: '+212612345678',
  priorite: 'Normale',
};

function parseCliArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    const arg = String(raw || '');
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).trim().toLowerCase();
    const value = eq >= 0 ? arg.slice(eq + 1) : '';
    if (key) out[key] = value;
  }
  return out;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function loadConfig() {
  const args = parseCliArgs(process.argv);
  return {
    baseUrl: firstNonEmpty(
      args.url,
      args['base-url'],
      process.env.SMOKE_TEST_URL,
      process.env.BASE_URL,
      'http://localhost:3000'
    ).replace(/\/+$/, ''),
    doctorUser: firstNonEmpty(args['doctor-user'], args['doctor-username'], process.env.DOCTOR_USERNAME),
    doctorPass: firstNonEmpty(args['doctor-pass'], args['doctor-password'], process.env.DOCTOR_PASSWORD),
    assistantUser: firstNonEmpty(
      args['assistant-user'],
      args['assistant-username'],
      process.env.ASSISTANT_USERNAME
    ),
    assistantPass: firstNonEmpty(
      args['assistant-pass'],
      args['assistant-password'],
      process.env.ASSISTANT_PASSWORD
    ),
  };
}

function cookieHeader(cookieMap) {
  return Object.entries(cookieMap)
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

function captureSessionCookies(headers, previous = {}) {
  const next = { ...previous };
  for (const line of collectSetCookieHeaders(headers)) {
    const pair = String(line || '').split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === SESSION_COOKIE || name === 'dentaflow_session_ast') {
      next[name] = value;
    }
  }
  return next;
}

async function request(baseUrl, method, pathname, { body, cookies } = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('This script requires Node.js 18+ (global fetch).');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = { Accept: 'application/json' };
  const cookie = cookieHeader(cookies || {});
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
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

    return {
      status: response.status,
      json,
      text,
      cookies: captureSessionCookies(response.headers, cookies || {}),
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

function fail(reason) {
  return { ok: false, detail: reason };
}

function pass(detail) {
  return { ok: true, detail };
}

function requireCredentials(role, user, pass) {
  if (!user || !pass) {
    return fail(
      `Missing ${role} credentials (set ${role === 'doctor' ? 'DOCTOR_USERNAME/DOCTOR_PASSWORD' : 'ASSISTANT_USERNAME/ASSISTANT_PASSWORD'})`
    );
  }
  return null;
}

function requireSessionCookie(cookies) {
  if (!cookies?.[SESSION_COOKIE]) {
    return fail(`Missing ${SESSION_COOKIE} cookie from login`);
  }
  return null;
}

async function testHealth(cfg) {
  const res = await request(cfg.baseUrl, 'GET', '/api/health');
  const status = res.json && typeof res.json === 'object' ? res.json.status : null;
  const statusOk = status === 'healthy' || status === 'degraded';
  // Health returns 200 when all deps are up, 503 when degraded. Both are a working endpoint.
  const httpOk = res.status === 200 || (res.status === 503 && status === 'degraded');
  if (httpOk && statusOk) {
    return pass(`HTTP ${res.status}, status=${status}`);
  }
  return fail(`HTTP ${res.status}, status=${status ?? '(none)'} body=${(res.text || '').slice(0, 200)}`);
}

async function testLogin(cfg, role, user, pass) {
  const missing = requireCredentials(role, user, pass);
  if (missing) return { ...missing, cookies: {} };

  const res = await request(cfg.baseUrl, 'POST', '/api/auth', {
    body: { role, username: user, password: pass },
  });
  const body = res.json || {};
  const cookieOk = Boolean(res.cookies[SESSION_COOKIE]);
  if (res.status === 200 && body.ok === true && body.role === role && cookieOk) {
    return { ok: true, detail: `HTTP 200, role=${body.role}, cookie captured`, cookies: res.cookies };
  }
  return {
    ok: false,
    detail: `HTTP ${res.status}, ok=${body.ok}, role=${body.role}, cookie=${cookieOk ? 'yes' : 'no'} body=${(res.text || '').slice(0, 200)}`,
    cookies: res.cookies,
  };
}

async function testDoctorMe(cfg, cookies) {
  const missing = requireSessionCookie(cookies);
  if (missing) return missing;

  const res = await request(cfg.baseUrl, 'POST', '/api/auth/me', {
    cookies,
    body: { expectedRole: 'doctor' },
  });
  const body = res.json || {};
  if (res.status === 200 && body.ok === true && body.role === 'doctor') {
    return pass(`HTTP 200, role=${body.role}`);
  }
  return fail(`HTTP ${res.status}, ok=${body.ok}, role=${body.role} body=${(res.text || '').slice(0, 200)}`);
}

async function testRoster(cfg, cookies) {
  const missing = requireSessionCookie(cookies);
  if (missing) return missing;

  const res = await request(cfg.baseUrl, 'GET', '/api/roster', { cookies });
  const body = res.json || {};
  if (res.status === 200 && body.ok === true && Array.isArray(body.data)) {
    return pass(`HTTP 200, ${body.data.length} row(s)`);
  }
  return fail(`HTTP ${res.status}, ok=${body.ok}, data=${Array.isArray(body.data) ? 'array' : typeof body.data} body=${(res.text || '').slice(0, 200)}`);
}

async function testWaitlistGet(cfg, cookies) {
  const missing = requireSessionCookie(cookies);
  if (missing) return missing;

  const res = await request(cfg.baseUrl, 'GET', '/api/waitlist', { cookies });
  const body = res.json || {};
  if (res.status === 200 && body.ok === true && Array.isArray(body.data)) {
    return pass(`HTTP 200, ${body.data.length} row(s)`);
  }
  return fail(`HTTP ${res.status}, ok=${body.ok}, data=${Array.isArray(body.data) ? 'array' : typeof body.data} body=${(res.text || '').slice(0, 200)}`);
}

async function testWaitlistAdd(cfg, cookies) {
  const missing = requireSessionCookie(cookies);
  if (missing) return missing;

  const res = await request(cfg.baseUrl, 'POST', '/api/waitlist', {
    cookies,
    body: WAITLIST_TEST_BODY,
  });
  const body = res.json || {};
  if (res.status === 200 && body.ok === true) {
    return pass(`HTTP 200, ok=true`);
  }
  return fail(`HTTP ${res.status}, ok=${body.ok} body=${(res.text || '').slice(0, 200)}`);
}

async function testLogout(cfg, cookies) {
  const res = await request(cfg.baseUrl, 'POST', '/api/auth/logout', {
    cookies: cookies || {},
    body: {},
  });
  const body = res.json || {};
  if (res.status === 200 && (body.ok === true || body.ok === undefined)) {
    return pass(`HTTP 200`);
  }
  return fail(`HTTP ${res.status} body=${(res.text || '').slice(0, 200)}`);
}

function printResult(index, name, result) {
  const tag = result.ok ? 'PASS' : 'FAIL';
  const detail = result.detail ? ` — ${result.detail}` : '';
  console.log(`TEST ${index}: ${name} ... ${tag}${detail}`);
}

async function runOne(index, name, fn) {
  try {
    const result = await fn();
    printResult(index, name, result);
    return result;
  } catch (err) {
    const result = fail(err?.message || String(err));
    printResult(index, name, result);
    return result;
  }
}

async function main() {
  const cfg = loadConfig();
  console.log(`DentaFlow OS smoke test → ${cfg.baseUrl}`);

  const results = [];
  let doctorCookies = {};
  let assistantCookies = {};

  const t1 = await runOne(1, 'Health check', () => testHealth(cfg));
  results.push(t1);

  const t2 = await runOne(2, 'Doctor login', async () => {
    const result = await testLogin(cfg, 'doctor', cfg.doctorUser, cfg.doctorPass);
    doctorCookies = result.cookies || {};
    return result;
  });
  results.push(t2);

  const t3 = await runOne(3, 'Doctor session probe', () => testDoctorMe(cfg, doctorCookies));
  results.push(t3);

  const t4 = await runOne(4, 'Doctor roster access', () => testRoster(cfg, doctorCookies));
  results.push(t4);

  const t5 = await runOne(5, 'Assistant login', async () => {
    const result = await testLogin(cfg, 'assistant', cfg.assistantUser, cfg.assistantPass);
    assistantCookies = result.cookies || {};
    return result;
  });
  results.push(t5);

  const t6 = await runOne(6, 'Assistant waitlist access', () => testWaitlistGet(cfg, assistantCookies));
  results.push(t6);

  const t7 = await runOne(7, 'Assistant waitlist add', () => testWaitlistAdd(cfg, assistantCookies));
  results.push(t7);

  const t8 = await runOne(8, 'Logout', () => testLogout(cfg, assistantCookies[SESSION_COOKIE] ? assistantCookies : doctorCookies));
  results.push(t8);

  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/8 tests passed`);
  process.exit(passed === 8 ? 0 : 1);
}

main().catch((err) => {
  console.error(`FAIL — ${err?.message || err}`);
  console.log('0/8 tests passed');
  process.exit(1);
});
