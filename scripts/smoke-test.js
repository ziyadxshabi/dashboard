#!/usr/bin/env node
/**
 * HTTP smoke tests against the local DentaFlow OS server (PostgreSQL + cookie auth).
 *
 * Seeded credentials: docteur / dentaflow, assistante / dentaflow, clinic slug temara.
 * Obtains dentaflow_session from POST /api/auth and exercises roster, waitlist,
 * dashboard-data, public clinic, Cal.com webhook, password, and logout.
 *
 * Spawns scripts/dev-server.js when BASE_URL is unreachable. Leaves an already
 * running server untouched.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DASHBOARD = path.join(ROOT, 'Temara_Dashboard');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const CLINIC_SLUG = 'temara';
const SEED_PASSWORD = 'dentaflow';
const DOCTOR_USER = 'docteur';
const ASSISTANT_USER = 'assistante';

function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
  return true;
}

loadEnvFile(path.join(DASHBOARD, '.env.local'));
loadEnvFile(path.join(DASHBOARD, '.env'));

const stats = { passed: 0, failed: 0, skipped: 0 };
let spawned = null;

function ok(name, condition, detail) {
  if (condition) {
    stats.passed += 1;
    console.log(`  ok  ${name}`);
    return;
  }
  stats.failed += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function skip(name, reason) {
  stats.skipped += 1;
  console.log(`  skip ${name}${reason ? ` — ${reason}` : ''}`);
}

function applySetCookie(jar, setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of list) {
    const pair = String(header).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar[name] = value;
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function request(pathname, { method = 'GET', headers = {}, body, jar } = {}) {
  const merged = { Accept: 'application/json', ...headers };
  if (jar && Object.keys(jar).length) merged.Cookie = cookieHeader(jar);
  if (body !== undefined && !merged['Content-Type']) {
    merged['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: merged,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : response.headers.get('set-cookie');
  if (jar) applySetCookie(jar, setCookie);
  let json = null;
  const text = await response.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/api/public/clinic/${CLINIC_SLUG}`, {
        headers: { Accept: 'application/json' },
      });
      if (res.status > 0) return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

async function ensureServer() {
  if (await waitForServer(1500)) return;
  console.log(`Starting local dev server for smoke tests (${BASE_URL})…`);
  spawned = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  spawned.stdout.on('data', (chunk) => {
    process.stdout.write(`[dev-server] ${chunk}`);
  });
  spawned.stderr.on('data', (chunk) => {
    process.stderr.write(`[dev-server] ${chunk}`);
  });
  const up = await waitForServer(20000);
  if (!up) {
    throw new Error(`Dev server did not become ready at ${BASE_URL}`);
  }
}

function stopSpawnedServer() {
  if (!spawned || !spawned.pid) return;
  try {
    process.kill(spawned.pid, 'SIGTERM');
  } catch {
    // already exited
  }
  spawned = null;
}

async function restoreSeedPassword(username) {
  const { hashPassword } = require(path.join(DASHBOARD, 'api/_lib/auth-crypto.js'));
  const { query } = require(path.join(DASHBOARD, 'api/_lib/db.js'));
  const hash = hashPassword(SEED_PASSWORD);
  await query(
    `UPDATE staff_users su
     SET password_hash = $1
     FROM clinics c
     WHERE su.clinic_id = c.id
       AND lower(su.username) = lower($2)
       AND c.slug = $3`,
    [hash, username, CLINIC_SLUG]
  );
}

async function run() {
  console.log(`\n== HTTP smoke tests (${BASE_URL}) ==\n`);
  await ensureServer();

  const doctorJar = {};
  const assistantJar = {};

  console.log('[auth login]');
  const doctorLogin = await request('/api/auth', {
    method: 'POST',
    body: { username: DOCTOR_USER, password: SEED_PASSWORD, slug: CLINIC_SLUG },
    jar: doctorJar,
  });
  ok('POST /api/auth docteur returns 200', doctorLogin.status === 200, `status=${doctorLogin.status}`);
  ok('POST /api/auth docteur ok:true', doctorLogin.json?.ok === true);
  ok(
    'dentaflow_session cookie captured',
    Boolean(doctorJar.dentaflow_session),
    `cookies=${Object.keys(doctorJar).join(',')}`
  );
  ok(
    'login payload has no Baserow/n8n fields',
    !/baserow|n8n/i.test(JSON.stringify(doctorLogin.json || {}))
  );

  const assistantLogin = await request('/api/auth', {
    method: 'POST',
    body: { username: ASSISTANT_USER, password: SEED_PASSWORD, slug: CLINIC_SLUG, role: 'assistant' },
    jar: assistantJar,
  });
  ok('POST /api/auth assistante returns 200', assistantLogin.status === 200);
  ok('assistante dentaflow_session captured', Boolean(assistantJar.dentaflow_session));

  console.log('\n[roster]');
  const rosterAnon = await request('/api/roster');
  ok('GET /api/roster without cookie returns 401', rosterAnon.status === 401);

  const roster = await request('/api/roster', { jar: doctorJar });
  ok('GET /api/roster authenticated returns 200', roster.status === 200, `status=${roster.status} body=${roster.text}`);
  ok('GET /api/roster ok:true with data[]', roster.json?.ok === true && Array.isArray(roster.json?.data));

  console.log('\n[waitlist]');
  const waitlistGet = await request('/api/waitlist', { jar: assistantJar });
  ok('GET /api/waitlist authenticated returns 200', waitlistGet.status === 200, `status=${waitlistGet.status}`);
  ok('GET /api/waitlist data is an array', Array.isArray(waitlistGet.json?.data));

  const patientName = 'Patient Test Wave Smoke';
  const waitlistPost = await request('/api/waitlist', {
    method: 'POST',
    jar: assistantJar,
    body: { nom: patientName, telephone: '0612345678', priorite: 'Moyenne' },
  });
  ok('POST /api/waitlist returns 200', waitlistPost.status === 200, `status=${waitlistPost.status} body=${waitlistPost.text}`);
  ok('POST /api/waitlist ok:true', waitlistPost.json?.ok === true);
  ok('POST /api/waitlist returns id', Boolean(waitlistPost.json?.id));

  const waitlistAfter = await request('/api/waitlist', { jar: assistantJar });
  const found = (waitlistAfter.json?.data || []).some(
    (row) => row.nom === patientName || row.patient_name === patientName
  );
  ok('GET /api/waitlist includes inserted patient', found);

  if (waitlistPost.json?.id) {
    const { query } = require(path.join(DASHBOARD, 'api/_lib/db.js'));
    await query('DELETE FROM waitlist WHERE id = $1', [waitlistPost.json.id]);
  }

  console.log('\n[dashboard-data]');
  const dash = await request('/api/dashboard-data', { jar: doctorJar });
  ok('GET /api/dashboard-data returns 200', dash.status === 200, `status=${dash.status}`);
  ok('GET /api/dashboard-data ok:true', dash.json?.ok === true);
  ok(
    'GET /api/dashboard-data Postgres aggregations present',
    typeof dash.json?.data?.patients_today === 'number'
  );

  console.log('\n[public clinic]');
  const clinic = await request(`/api/public/clinic/${CLINIC_SLUG}`);
  ok('GET /api/public/clinic/temara returns 200', clinic.status === 200, `status=${clinic.status}`);
  ok('public clinic slug is temara', clinic.json?.clinic?.slug === CLINIC_SLUG);

  console.log('\n[webhooks/cal]');
  const calFile = fs.existsSync(path.join(DASHBOARD, 'api/webhooks/cal.js'));
  const cal = await request('/api/webhooks/cal', {
    method: 'POST',
    body: { triggerEvent: 'PING' },
  });
  if (!calFile && cal.status === 404) {
    skip('POST /api/webhooks/cal', 'handler not present on this branch (Wave 2)');
  } else {
    ok('POST /api/webhooks/cal PING returns 200', cal.status === 200, `status=${cal.status} body=${cal.text}`);
    ok('Cal webhook ok:true', cal.json?.ok === true);
  }

  console.log('\n[auth password]');
  const NEW_PASSWORD = 'smokePass9';
  try {
    const missing = await request('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: SEED_PASSWORD, newPassword: NEW_PASSWORD },
    });
    ok('POST /api/auth/password without cookie returns 401', missing.status === 401);

    const shortPwd = await request('/api/auth/password', {
      method: 'POST',
      jar: assistantJar,
      body: { currentPassword: SEED_PASSWORD, newPassword: '123' },
    });
    ok('POST /api/auth/password short password returns 400', shortPwd.status === 400);

    const wrong = await request('/api/auth/password', {
      method: 'POST',
      jar: assistantJar,
      body: { oldPassword: 'nope-nope', newPassword: NEW_PASSWORD },
    });
    ok('POST /api/auth/password wrong current returns 401', wrong.status === 401);

    const changed = await request('/api/auth/password', {
      method: 'POST',
      jar: assistantJar,
      body: { currentPassword: SEED_PASSWORD, newPassword: NEW_PASSWORD },
    });
    ok('POST /api/auth/password returns 200', changed.status === 200, `status=${changed.status} body=${changed.text}`);
    ok(
      'password change message',
      changed.json?.ok === true && changed.json?.message === 'Mot de passe mis à jour avec succès'
    );

    const newJar = {};
    const relogin = await request('/api/auth', {
      method: 'POST',
      body: { username: ASSISTANT_USER, password: NEW_PASSWORD, slug: CLINIC_SLUG },
      jar: newJar,
    });
    ok('login with rotated password succeeds', relogin.status === 200 && Boolean(newJar.dentaflow_session));

    const restore = await request('/api/auth?action=password', {
      method: 'POST',
      jar: newJar,
      body: { currentPassword: NEW_PASSWORD, newPassword: SEED_PASSWORD },
    });
    ok('POST /api/auth?action=password restores seed', restore.status === 200 && restore.json?.ok === true);
  } finally {
    await restoreSeedPassword(ASSISTANT_USER);
  }

  console.log('\n[auth logout]');
  const logoutRes = await request('/api/auth/logout', { method: 'POST', jar: doctorJar });
  ok('POST /api/auth/logout returns 200', logoutRes.status === 200);
  ok('POST /api/auth/logout ok:true', logoutRes.json?.ok === true);

  const rosterAfterLogout = await request('/api/roster');
  ok('GET /api/roster without cookie after logout is 401', rosterAfterLogout.status === 401);

  console.log(
    `\nSmoke test results: ${stats.passed} passed, ${stats.failed} failed, ${stats.skipped} skipped\n`
  );
  if (stats.failed > 0) process.exitCode = 1;
}

run()
  .catch((err) => {
    console.error('Smoke suite crashed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await restoreSeedPassword(ASSISTANT_USER);
    } catch {
      // ignore restore errors during shutdown
    }
    stopSpawnedServer();
  });
