#!/usr/bin/env node
/**
 * Direct handler tests against local PostgreSQL.
 * Loads Temara_Dashboard/.env.local, invokes serverless handlers with a
 * Vercel-compatible (req, res) shim, and asserts the Wave 1/3 API contracts.
 *
 * Seeded credentials: docteur / dentaflow, assistante / dentaflow, clinic slug temara.
 * Auth cookie: dentaflow_session.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DASHBOARD = path.join(ROOT, 'Temara_Dashboard');

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

loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(DASHBOARD, '.env.local'));
loadEnvFile(path.join(DASHBOARD, '.env'));

const handleAuth = require(path.join(DASHBOARD, 'api/auth.js'));
const handlePassword = require(path.join(DASHBOARD, 'api/auth/password.js'));
const handleRoster = require(path.join(DASHBOARD, 'api/roster.js'));
const handleWaitlist = require(path.join(DASHBOARD, 'api/waitlist.js'));
const handleDashboard = require(path.join(DASHBOARD, 'api/dashboard-data.js'));
const handlePublicClinic = require(path.join(DASHBOARD, 'api/public/clinic.js'));
const { query } = require(path.join(DASHBOARD, 'api/_lib/db.js'));
const { hashPassword, verifyPassword } = require(path.join(DASHBOARD, 'api/_lib/auth-crypto.js'));

const CLINIC_SLUG = 'temara';
const SEED_PASSWORD = 'dentaflow';
const DOCTOR_USER = 'docteur';
const ASSISTANT_USER = 'assistante';

function staffUsernameAliases(username) {
  const key = String(username || '').trim().toLowerCase();
  if (key === 'doctor' || key === 'docteur') return ['doctor', 'docteur'];
  if (key === 'assistant' || key === 'assistante') return ['assistant', 'assistante'];
  return [key];
}

const stats = { passed: 0, failed: 0, skipped: 0 };

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    json(obj) {
      this.body = obj;
      this.headersSent = true;
      if (!this.getHeader('content-type')) {
        this.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      return this;
    },
    end(data) {
      if (data !== undefined) this.body = data;
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

function createReq({ method, url, headers = {}, body, query: queryParams }) {
  const parsed = new URL(url, 'http://localhost');
  return {
    method,
    url,
    headers: { ...headers },
    body,
    query: queryParams || Object.fromEntries(parsed.searchParams),
  };
}

async function invoke(handler, req) {
  const res = createRes();
  await handler(req, res);
  return res;
}

function extractSessionCookie(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const header of list) {
    const match = String(header).match(/dentaflow_session=([^;]+)/i);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

function cookieHeader(token) {
  return token ? `dentaflow_session=${encodeURIComponent(token)}` : '';
}

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

async function login(username, password) {
  const res = await invoke(
    handleAuth,
    createReq({
      method: 'POST',
      url: '/api/auth',
      headers: { 'content-type': 'application/json' },
      body: { username, password, slug: CLINIC_SLUG },
    })
  );
  const token = extractSessionCookie(res);
  return { res, token };
}

async function restoreSeedPassword(username) {
  const hash = hashPassword(SEED_PASSWORD);
  await query(
    `UPDATE staff_users su
     SET password_hash = $1
     FROM clinics c
     WHERE su.clinic_id = c.id
       AND lower(su.username) = ANY($2::text[])
       AND c.slug = $3`,
    [hash, staffUsernameAliases(username), CLINIC_SLUG]
  );
}

async function run() {
  console.log('\n== Direct handler tests (PostgreSQL) ==\n');

  ok(
    'DATABASE_URL is configured',
    Boolean(String(process.env.DATABASE_URL || '').trim())
  );
  ok('JWT_SECRET is configured', Boolean(String(process.env.JWT_SECRET || '').trim()));

  await restoreSeedPassword(DOCTOR_USER);
  await restoreSeedPassword(ASSISTANT_USER);

  // ── Login + session cookie ─────────────────────────────────────────────
  console.log('\n[auth login]');
  const doctorLogin = await login(DOCTOR_USER, SEED_PASSWORD);
  ok('POST /api/auth docteur returns 200', doctorLogin.res.statusCode === 200, `status=${doctorLogin.res.statusCode}`);
  ok('POST /api/auth docteur ok:true', doctorLogin.res.body?.ok === true);
  ok(
    'POST /api/auth sets dentaflow_session cookie',
    Boolean(doctorLogin.token),
    'missing Set-Cookie dentaflow_session'
  );
  ok(
    'POST /api/auth does not mention Baserow/n8n',
    !/baserow|n8n/i.test(JSON.stringify(doctorLogin.res.body || {}))
  );

  const assistantLogin = await login(ASSISTANT_USER, SEED_PASSWORD);
  ok('POST /api/auth assistante returns 200', assistantLogin.res.statusCode === 200);
  ok('POST /api/auth assistante sets dentaflow_session', Boolean(assistantLogin.token));

  const badLogin = await login(DOCTOR_USER, 'wrong-password');
  ok('POST /api/auth rejects bad password with 401', badLogin.res.statusCode === 401);

  const doctorCookie = { cookie: cookieHeader(doctorLogin.token) };
  const assistantCookie = { cookie: cookieHeader(assistantLogin.token) };

  // ── Unauthenticated gate ───────────────────────────────────────────────
  console.log('\n[authz]');
  const rosterAnon = await invoke(handleRoster, createReq({ method: 'GET', url: '/api/roster', headers: {} }));
  ok('GET /api/roster without cookie returns 401', rosterAnon.statusCode === 401);

  const waitlistAnon = await invoke(handleWaitlist, createReq({ method: 'GET', url: '/api/waitlist', headers: {} }));
  ok('GET /api/waitlist without cookie returns 401', waitlistAnon.statusCode === 401);

  // ── Roster (Postgres) ──────────────────────────────────────────────────
  console.log('\n[roster]');
  const roster = await invoke(
    handleRoster,
    createReq({ method: 'GET', url: '/api/roster', headers: doctorCookie })
  );
  ok('GET /api/roster authenticated returns 200', roster.statusCode === 200, `status=${roster.statusCode}`);
  ok('GET /api/roster ok:true', roster.body?.ok === true);
  ok('GET /api/roster data is an array', Array.isArray(roster.body?.data));

  // ── Waitlist GET + POST ────────────────────────────────────────────────
  console.log('\n[waitlist]');
  const waitlistGet = await invoke(
    handleWaitlist,
    createReq({ method: 'GET', url: '/api/waitlist', headers: assistantCookie })
  );
  ok('GET /api/waitlist authenticated returns 200', waitlistGet.statusCode === 200, `status=${waitlistGet.statusCode}`);
  ok('GET /api/waitlist data is an array', Array.isArray(waitlistGet.body?.data));

  const patientName = 'Patient Test Wave Handler';
  const waitlistPost = await invoke(
    handleWaitlist,
    createReq({
      method: 'POST',
      url: '/api/waitlist',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: {
        nom: patientName,
        telephone: '0612345678',
        priorite: 'Haute',
      },
    })
  );
  ok('POST /api/waitlist returns 200', waitlistPost.statusCode === 200, `status=${waitlistPost.statusCode} body=${JSON.stringify(waitlistPost.body)}`);
  ok('POST /api/waitlist ok:true', waitlistPost.body?.ok === true);
  ok('POST /api/waitlist returns id', Boolean(waitlistPost.body?.id));

  const waitlistAfter = await invoke(
    handleWaitlist,
    createReq({ method: 'GET', url: '/api/waitlist', headers: assistantCookie })
  );
  const found = (waitlistAfter.body?.data || []).some((row) => row.nom === patientName || row.patient_name === patientName);
  ok('GET /api/waitlist includes the inserted patient', found);

  if (waitlistPost.body?.id) {
    await query('DELETE FROM waitlist WHERE id = $1', [waitlistPost.body.id]);
  }

  const waitlistBadPhone = await invoke(
    handleWaitlist,
    createReq({
      method: 'POST',
      url: '/api/waitlist',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: { nom: 'X', telephone: '123', priorite: 'Haute' },
    })
  );
  ok('POST /api/waitlist rejects invalid input with 400', waitlistBadPhone.statusCode === 400);

  // ── Dashboard KPIs ─────────────────────────────────────────────────────
  console.log('\n[dashboard-data]');
  const dash = await invoke(
    handleDashboard,
    createReq({ method: 'GET', url: '/api/dashboard-data', headers: doctorCookie })
  );
  ok('GET /api/dashboard-data returns 200', dash.statusCode === 200, `status=${dash.statusCode}`);
  ok('GET /api/dashboard-data ok:true', dash.body?.ok === true);
  ok(
    'GET /api/dashboard-data exposes Postgres aggregations',
    typeof dash.body?.data?.patients_today === 'number' &&
      typeof dash.body?.data?.accepted_plans === 'number' &&
      typeof dash.body?.data?.pending_plans === 'number' &&
      typeof dash.body?.data?.no_shows === 'number',
    JSON.stringify(dash.body)
  );

  // ── Public clinic ──────────────────────────────────────────────────────
  console.log('\n[public clinic]');
  const clinic = await invoke(
    handlePublicClinic,
    createReq({
      method: 'GET',
      url: '/api/public/clinic/temara',
      query: { slug: CLINIC_SLUG },
    })
  );
  ok('GET /api/public/clinic/temara returns 200', clinic.statusCode === 200, `status=${clinic.statusCode}`);
  ok('public clinic slug is temara', clinic.body?.clinic?.slug === CLINIC_SLUG);
  ok('public clinic does not leak clinic UUID', clinic.body?.clinic?.id == null);

  // ── Password change (scrypt + staff_users) ─────────────────────────────
  console.log('\n[auth password]');
  const missingSession = await invoke(
    handlePassword,
    createReq({
      method: 'POST',
      url: '/api/auth/password',
      headers: { 'content-type': 'application/json' },
      body: { currentPassword: SEED_PASSWORD, newPassword: 'abcdefgh' },
    })
  );
  ok('POST /api/auth/password without cookie returns 401', missingSession.statusCode === 401);

  const shortPwd = await invoke(
    handlePassword,
    createReq({
      method: 'POST',
      url: '/api/auth/password',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: { currentPassword: SEED_PASSWORD, newPassword: 'short' },
    })
  );
  ok('POST /api/auth/password rejects short newPassword with 400', shortPwd.statusCode === 400);
  ok('short newPassword uses VALIDATION_ERROR', shortPwd.body?.code === 'VALIDATION_ERROR');

  const wrongCurrent = await invoke(
    handlePassword,
    createReq({
      method: 'POST',
      url: '/api/auth/password',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: { oldPassword: 'not-the-password', newPassword: 'newpass12' },
    })
  );
  ok('POST /api/auth/password wrong current returns 401', wrongCurrent.statusCode === 401);
  ok(
    'wrong current uses French UNAUTHORIZED message',
    wrongCurrent.body?.code === 'UNAUTHORIZED' &&
      /mot de passe actuel incorrect/i.test(String(wrongCurrent.body?.error || ''))
  );

  const NEW_PASSWORD = 'wave3pass!';
  try {
    const changed = await invoke(
      handlePassword,
      createReq({
        method: 'POST',
        url: '/api/auth/password',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { currentPassword: SEED_PASSWORD, newPassword: NEW_PASSWORD },
      })
    );
    ok('POST /api/auth/password returns 200', changed.statusCode === 200, `status=${changed.statusCode} body=${JSON.stringify(changed.body)}`);
    ok('password change ok:true', changed.body?.ok === true);
    ok(
      'password change success message',
      changed.body?.message === 'Mot de passe mis à jour avec succès'
    );

    const hashRow = await query(
      `SELECT su.password_hash
       FROM staff_users su
       INNER JOIN clinics c ON c.id = su.clinic_id
       WHERE lower(su.username) = ANY($1::text[]) AND c.slug = $2
       LIMIT 1`,
      [staffUsernameAliases(ASSISTANT_USER), CLINIC_SLUG]
    );
    const storedHash = hashRow.rows[0]?.password_hash || '';
    ok('updated hash uses scrypt$ prefix', storedHash.startsWith('scrypt$'));
    ok('verifyPassword accepts the new password', verifyPassword(NEW_PASSWORD, storedHash));
    ok('verifyPassword rejects the old password', !verifyPassword(SEED_PASSWORD, storedHash));

    const reloginOld = await login(ASSISTANT_USER, SEED_PASSWORD);
    ok('login with old password fails after change', reloginOld.res.statusCode === 401);

    const reloginNew = await login(ASSISTANT_USER, NEW_PASSWORD);
    ok('login with new password succeeds', reloginNew.res.statusCode === 200 && Boolean(reloginNew.token));

    const viaAction = await invoke(
      handleAuth,
      createReq({
        method: 'POST',
        url: '/api/auth?action=password',
        headers: {
          cookie: cookieHeader(reloginNew.token),
          'content-type': 'application/json',
        },
        body: { currentPassword: NEW_PASSWORD, newPassword: SEED_PASSWORD },
      })
    );
    ok(
      'POST /api/auth?action=password restores seed password',
      viaAction.statusCode === 200 && viaAction.body?.ok === true,
      `status=${viaAction.statusCode} body=${JSON.stringify(viaAction.body)}`
    );
  } finally {
    await restoreSeedPassword(ASSISTANT_USER);
  }

  const restoredLogin = await login(ASSISTANT_USER, SEED_PASSWORD);
  ok('assistante seed password restored', restoredLogin.res.statusCode === 200);

  // ── Cal.com webhook ────────────────────────────────────────────────────
  console.log('\n[webhooks/cal]');
  const calPath = path.join(DASHBOARD, 'api/webhooks/cal.js');
  if (fs.existsSync(calPath)) {
    const handleCal = require(calPath);
    const ping = await invoke(
      handleCal,
      createReq({
        method: 'POST',
        url: '/api/webhooks/cal',
        headers: { 'content-type': 'application/json' },
        body: { triggerEvent: 'PING' },
      })
    );
    ok('POST /api/webhooks/cal PING returns 200', ping.statusCode === 200, `status=${ping.statusCode}`);
    ok('Cal webhook ok:true', ping.body?.ok === true);

    const missingUid = await invoke(
      handleCal,
      createReq({
        method: 'POST',
        url: '/api/webhooks/cal',
        headers: { 'content-type': 'application/json' },
        body: { triggerEvent: 'BOOKING_CREATED' },
      })
    );
    ok('POST /api/webhooks/cal BOOKING_CREATED without uid returns 400', missingUid.statusCode === 400);
  } else {
    skip('POST /api/webhooks/cal', 'handler not present on this branch (Wave 2)');
  }

  // ── Logout ─────────────────────────────────────────────────────────────
  console.log('\n[auth logout]');
  const logoutRes = await invoke(
    handleAuth,
    createReq({
      method: 'POST',
      url: '/api/auth/logout',
      headers: doctorCookie,
    })
  );
  ok('POST /api/auth/logout returns 200', logoutRes.statusCode === 200);
  ok('POST /api/auth/logout ok:true', logoutRes.body?.ok === true);
  const cleared = JSON.stringify(logoutRes.headers['set-cookie'] || '');
  ok('POST /api/auth/logout clears dentaflow_session', /dentaflow_session=.*Max-Age=0/i.test(cleared));

  const afterLogout = await invoke(handleRoster, createReq({ method: 'GET', url: '/api/roster', headers: {} }));
  ok('GET /api/roster without cookie after logout is 401', afterLogout.statusCode === 401);

  console.log(
    `\nDirect handler results: ${stats.passed} passed, ${stats.failed} failed, ${stats.skipped} skipped\n`
  );
  if (stats.failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Direct handler suite crashed:', err);
  restoreSeedPassword(ASSISTANT_USER)
    .catch(() => undefined)
    .finally(() => process.exit(1));
});
