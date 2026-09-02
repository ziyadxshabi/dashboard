/**
 * DentaFlow OS — direct API handler tests (no HTTP server).
 * Loads .env.local via fs, then invokes Temara_Dashboard/api handlers with mock req/res.
 *
 * Usage:
 *   node scripts/test-handlers-direct.js
 *   DOCTOR_USERNAME=docteur DOCTOR_PASSWORD=test-password node scripts/test-handlers-direct.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT, 'Temara_Dashboard', 'api');
const SESSION_COOKIE = 'dentaflow_session';
const FALLBACK_DOCTOR_USER = 'docteur';
const FALLBACK_DOCTOR_PASS = 'test-password';
const TEST_JWT_SECRET = 'test-jwt-secret-for-local-handler-tests-32ch';

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function parseEnvLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq < 1) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return key ? { key, value } : null;
}

function loadEnvFile(filePath, { override = false } = {}) {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (!override && process.env[parsed.key] != null && process.env[parsed.key] !== '') continue;
    process.env[parsed.key] = parsed.value;
  }
  return true;
}

function loadEnvLocal() {
  const loaded = [];
  const rootEnv = path.join(ROOT, '.env.local');
  const dashEnv = path.join(ROOT, 'Temara_Dashboard', '.env.local');
  if (loadEnvFile(rootEnv, { override: false })) loaded.push(rootEnv);
  if (loadEnvFile(dashEnv, { override: true })) loaded.push(dashEnv);
  return loaded;
}

function createReq({
  method = 'GET',
  url = '/',
  headers = {},
  query = {},
  body,
  cookies = {},
} = {}) {
  const headerBag = {};
  for (const [name, value] of Object.entries(headers || {})) {
    headerBag[String(name).toLowerCase()] = value;
  }

  const cookiePairs = Object.entries(cookies || {}).filter(([, value]) => value != null && value !== '');
  if (cookiePairs.length && !headerBag.cookie) {
    headerBag.cookie = cookiePairs
      .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`)
      .join('; ');
  }

  return {
    method,
    url,
    headers: headerBag,
    query,
    body,
    cookies: { ...(cookies || {}) },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function createRes() {
  const headers = Object.create(null);
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    headers,
    status(code) {
      this.statusCode = Number(code);
      return this;
    },
    json(data) {
      this.body = data;
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
      this.ended = true;
      return this;
    },
    send(data) {
      if (typeof data === 'string') {
        try {
          this.body = JSON.parse(data);
        } catch {
          this.body = data;
        }
      } else {
        this.body = data;
      }
      this.ended = true;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    end(data) {
      if (data !== undefined) this.body = data;
      this.ended = true;
      return this;
    },
  };
}

function headerLines(res, name) {
  const raw = res.getHeader(name);
  if (raw == null) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function cookieJarFromRes(res) {
  const jar = {};
  for (const line of headerLines(res, 'set-cookie')) {
    const pair = String(line).split(';')[0] || '';
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      jar[name] = value;
    }
  }
  return jar;
}

function cookieExpired(res) {
  return headerLines(res, 'set-cookie').some((line) => {
    const lower = String(line).toLowerCase();
    const name = String(line).split('=')[0].trim();
    return name === SESSION_COOKIE && (/max-age=0\b/.test(lower) || /=\s*;/.test(String(line)));
  });
}

function bodyCode(body) {
  return body && typeof body === 'object' ? body.code : undefined;
}

async function invoke(handler, req) {
  const res = createRes();
  const started = Date.now();
  await handler(req, res);
  return { req, res, latencyMs: Date.now() - started };
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
    result.name = name;
    result.latencyMs = result.latencyMs != null ? result.latencyMs : Date.now() - started;
    printResult(index, name, result);
    return result;
  } catch (err) {
    const result = {
      name,
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      body: null,
      detail: err?.message || String(err),
    };
    printResult(index, name, result);
    return result;
  }
}

function prepareAuthEnv() {
  const notes = [];
  const doctorUser = firstNonEmpty(process.env.DOCTOR_USERNAME, FALLBACK_DOCTOR_USER);
  const doctorPass = firstNonEmpty(process.env.DOCTOR_PASSWORD, FALLBACK_DOCTOR_PASS);
  process.env.DOCTOR_USERNAME = doctorUser;

  if (!firstNonEmpty(process.env.JWT_SECRET)) {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    notes.push('JWT_SECRET missing in .env.local; applied in-process test secret');
  }

  const { hashPassword, verifyPassword } = require(path.join(API_DIR, '_lib', 'auth-crypto'));
  const storedHash = String(process.env.DOCTOR_PASSWORD_HASH || '');
  let hashOk = false;
  try {
    hashOk = verifyPassword(doctorPass, storedHash);
  } catch {
    hashOk = false;
  }
  if (!hashOk) {
    process.env.DOCTOR_PASSWORD_HASH = hashPassword(doctorPass);
    notes.push('DOCTOR_PASSWORD_HASH did not verify test password (expected scrypt$); generated in-process scrypt hash');
  }

  if (!firstNonEmpty(process.env.N8N_WEBHOOK_UPDATE_STATUS)) {
    process.env.N8N_WEBHOOK_UPDATE_STATUS = 'http://127.0.0.1:9/update-status';
    notes.push('N8N_WEBHOOK_UPDATE_STATUS missing; applied in-process dummy URL so validation runs before upstream fetch');
  }

  return { doctorUser, doctorPass, notes };
}

async function main() {
  const loaded = loadEnvLocal();
  const authEnv = prepareAuthEnv();

  const { signJwt } = require(path.join(API_DIR, '_lib', 'auth-crypto'));
  const health = require(path.join(API_DIR, 'health.js'));
  const dashboardData = require(path.join(API_DIR, 'dashboard-data.js'));
  const roster = require(path.join(API_DIR, 'roster.js'));
  const updateStatus = require(path.join(API_DIR, 'update-status.js'));
  const leadCapture = require(path.join(API_DIR, 'lead-capture.js'));
  const auth = require(path.join(API_DIR, 'auth.js'));
  const mintedSession = signJwt(
    { role: 'doctor', sub: authEnv.doctorUser },
    process.env.JWT_SECRET
  );

  console.log('');
  console.log('DentaFlow OS direct handler tests');
  console.log(`API dir: ${API_DIR}`);
  console.log(`Env files: ${loaded.length ? loaded.join(' | ') : '(none found)'}`);
  if (authEnv.notes.length) {
    for (const note of authEnv.notes) console.log(`Env note: ${note}`);
  }
  console.log(`Doctor: ${authEnv.doctorUser}`);
  console.log('─'.repeat(64));

  const captured = { health: null, auth: null };
  let sessionCookie = '';

  const results = [];

  results.push(
    await runOne(1, 'health.js GET', async () => {
      const { res, latencyMs } = await invoke(
        health,
        createReq({ method: 'GET', url: '/api/health' })
      );
      captured.health = res.body;
      const payload = res.body && typeof res.body === 'object' ? res.body : null;
      const httpOk = res.statusCode === 200 || res.statusCode === 503;
      const hasStatus = typeof payload?.status === 'string';
      const hasServices = payload?.services != null && typeof payload.services === 'object';
      const ok = httpOk && hasStatus && hasServices;
      return {
        ok,
        status: res.statusCode,
        latencyMs,
        body: res.body,
        detail: ok
          ? `status=${payload.status}, services=${Object.keys(payload.services).join(',')}`
          : `expected 200/503 with status+services, body=${JSON.stringify(res.body)}`.slice(0, 220),
      };
    })
  );

  results.push(
    await runOne(2, 'dashboard-data.js POST', async () => {
      const { res, latencyMs } = await invoke(
        dashboardData,
        createReq({ method: 'POST', url: '/api/dashboard-data', body: {} })
      );
      const ok = res.statusCode === 405 && bodyCode(res.body) === 'METHOD_NOT_ALLOWED';
      return {
        ok,
        status: res.statusCode,
        latencyMs,
        body: res.body,
        detail: ok ? `code=${bodyCode(res.body)}` : `expected 405 METHOD_NOT_ALLOWED, body=${JSON.stringify(res.body)}`.slice(0, 220),
      };
    })
  );

  results.push(
    await runOne(3, 'roster.js GET unauthenticated', async () => {
      const { res, latencyMs } = await invoke(
        roster,
        createReq({ method: 'GET', url: '/api/roster' })
      );
      const unauthorized =
        res.statusCode === 401 &&
        (bodyCode(res.body) === 'UNAUTHORIZED' || /unauthorized/i.test(String(res.body?.error || '')));
      return {
        ok: unauthorized,
        status: res.statusCode,
        latencyMs,
        body: res.body,
        detail: unauthorized
          ? `code=${bodyCode(res.body) || 'UNAUTHORIZED'}`
          : `expected 401 UNAUTHORIZED, body=${JSON.stringify(res.body)}`.slice(0, 220),
      };
    })
  );

  results.push(
    await runOne(4, 'update-status.js POST invalid body', async () => {
      const { res, latencyMs } = await invoke(
        updateStatus,
        createReq({
          method: 'POST',
          url: '/api/update-status',
          cookies: { [SESSION_COOKIE]: mintedSession },
          body: { bookingId: '', newStatus: 'not-a-status' },
        })
      );
      const ok = res.statusCode === 400 && bodyCode(res.body) === 'VALIDATION_ERROR';
      return {
        ok,
        status: res.statusCode,
        latencyMs,
        body: res.body,
        detail: ok
          ? `code=${bodyCode(res.body)}`
          : `expected 400 VALIDATION_ERROR, body=${JSON.stringify(res.body)}`.slice(0, 220),
      };
    })
  );

  results.push(
    await runOne(5, 'lead-capture.js POST short name', async () => {
      const { res, latencyMs } = await invoke(
        leadCapture,
        createReq({
          method: 'POST',
          url: '/api/lead-capture',
          body: { nom: 'A', telephone: '0612345678' },
        })
      );
      const ok = res.statusCode === 400 && bodyCode(res.body) === 'VALIDATION_ERROR';
      return {
        ok,
        status: res.statusCode,
        latencyMs,
        body: res.body,
        detail: ok ? `code=${bodyCode(res.body)}` : `expected 400 VALIDATION_ERROR, body=${JSON.stringify(res.body)}`.slice(0, 220),
      };
    })
  );

  results.push(
    await runOne(6, 'auth.js POST doctor login', async () => {
      const { res, latencyMs } = await invoke(
        auth,
        createReq({
          method: 'POST',
          url: '/api/auth',
          body: {
            role: 'doctor',
            username: authEnv.doctorUser,
            password: authEnv.doctorPass,
          },
        })
      );
      captured.auth = res.body;
      const jar = cookieJarFromRes(res);
      sessionCookie = jar[SESSION_COOKIE] || '';
      const cookieOk = Boolean(sessionCookie);
      const ok = res.statusCode === 200 && res.body?.ok === true && res.body?.role === 'doctor' && cookieOk;
      return {
        ok,
        status: res.statusCode,
        latencyMs,
        body: res.body,
        detail: ok
          ? `role=${res.body.role}, cookie=${SESSION_COOKIE}`
          : `expected 200 + JWT cookie, cookie=${cookieOk} body=${JSON.stringify(res.body)}`.slice(0, 220),
      };
    })
  );

  results.push(
    await runOne(7, 'auth/logout POST', async () => {
      const { res, latencyMs } = await invoke(
        auth,
        createReq({
          method: 'POST',
          url: '/api/auth/logout',
          cookies: sessionCookie ? { [SESSION_COOKIE]: sessionCookie } : {},
          body: {},
        })
      );
      const cleared = cookieExpired(res);
      const ok = res.statusCode === 200 && (res.body?.ok === true || res.body?.ok === undefined) && cleared;
      return {
        ok,
        status: res.statusCode,
        latencyMs,
        body: res.body,
        detail: ok
          ? 'session cookie cleared (Max-Age=0)'
          : `expected 200 + Max-Age=0, cleared=${cleared} body=${JSON.stringify(res.body)}`.slice(0, 220),
      };
    })
  );

  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;

  console.log('─'.repeat(64));
  console.log(`Summary  Total: ${total}  Passed: ${passed}  Failed: ${failed}`);
  console.log('');
  console.log('CAPTURE health.js JSON');
  console.log(JSON.stringify(captured.health, null, 2));
  console.log('CAPTURE auth.js JSON');
  console.log(JSON.stringify(captured.auth, null, 2));
  console.log('');

  const validation = {
    'dashboard-data METHOD_NOT_ALLOWED': Boolean(results[1]?.ok),
    'roster UNAUTHORIZED': Boolean(results[2]?.ok),
    'update-status VALIDATION_ERROR': Boolean(results[3]?.ok),
    'lead-capture VALIDATION_ERROR': Boolean(results[4]?.ok),
  };
  const jwtPaths = {
    'auth login JWT cookie': Boolean(results[5]?.ok),
    'auth logout cookie expiration': Boolean(results[6]?.ok),
  };
  console.log('VALIDATION_GUARDS', JSON.stringify(validation));
  console.log('JWT_HASHING_PATHS', JSON.stringify(jwtPaths));

  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`✖ FAIL  runner crashed — ${err?.message || err}`);
  process.exitCode = 1;
});
