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
const crypto = require('node:crypto');

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
const handleRoster = require(path.join(DASHBOARD, 'api/roster.js'));
const handleWaitlist = require(path.join(DASHBOARD, 'api/waitlist.js'));
const handleDashboard = require(path.join(DASHBOARD, 'api/dashboard-data.js'));
const handlePublicClinic = require(path.join(DASHBOARD, 'api/public/clinic/[slug].js'));
const handleUpdateStatus = require(path.join(DASHBOARD, 'api/update-status.js'));
const { query } = require(path.join(DASHBOARD, 'api/_lib/db.js'));
const { hashPassword, verifyPassword, signJwt } = require(path.join(DASHBOARD, 'api/_lib/auth-crypto.js'));

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

function calWebhookHeaders(body) {
  const headers = { 'content-type': 'application/json' };
  const secret = String(process.env.CALCOM_WEBHOOK_SECRET || '').trim();
  if (!secret) return headers;
  headers['x-cal-signature-256'] = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
  return headers;
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

  // ── Status updates (Postgres bookings) ─────────────────────────────────
  console.log('\n[update-status]');
  await query(
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`
  );

  const clinicRow = await query('SELECT id FROM clinics WHERE slug = $1 LIMIT 1', [CLINIC_SLUG]);
  const clinicId = clinicRow.rows[0]?.id;
  ok('temara clinic id is available for status tests', Boolean(clinicId));

  let statusBookingId = null;
  try {
    const inserted = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status, starts_at, duration_min
       ) VALUES ($1, $2, $3, $4, 'Confirme'::appointment_status, NOW(), 30)
       RETURNING id`,
      [clinicId, 'Patient Test R13 Status', '0612345678', 'Controle']
    );
    statusBookingId = inserted.rows[0]?.id;
    ok('inserted clinic-scoped test booking', Boolean(statusBookingId));

    async function postStatus(status, headers = assistantCookie) {
      return invoke(
        handleUpdateStatus,
        createReq({
          method: 'POST',
          url: '/api/update-status',
          headers: { ...headers, 'content-type': 'application/json' },
          body: { bookingId: statusBookingId, newStatus: status },
        })
      );
    }

    const toSalle = await postStatus('en_salle');
    ok(
      'POST /api/update-status en_salle returns 200',
      toSalle.statusCode === 200,
      `status=${toSalle.statusCode} body=${JSON.stringify(toSalle.body)}`
    );
    ok(
      'en_salle writes En salle d\'attente',
      toSalle.body?.data?.status === "En salle d'attente" && toSalle.body?.data?.statusCode === 'en_salle'
    );

    const toSoin = await postStatus('En soin');
    ok('POST /api/update-status French "En soin" returns 200', toSoin.statusCode === 200);
    ok(
      'en_soin writes En soin',
      toSoin.body?.data?.status === 'En soin' && toSoin.body?.data?.statusCode === 'en_soin'
    );

    const toTermine = await postStatus('termine');
    ok('POST /api/update-status termine returns 200', toTermine.statusCode === 200);
    ok('termine writes Termine', toTermine.body?.data?.status === 'Termine');

    const toNoShow = await postStatus('no_show');
    ok('POST /api/update-status no_show returns 200', toNoShow.statusCode === 200);
    ok('no_show writes No-show', toNoShow.body?.data?.status === 'No-show');
    ok('status update stamps updated_at', Boolean(toNoShow.body?.data?.updated_at));

    const patchViaRoster = await invoke(
      handleRoster,
      createReq({
        method: 'PATCH',
        url: '/api/roster',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { bookingId: statusBookingId, newStatus: 'confirme' },
      })
    );
    ok('PATCH /api/roster confirme returns 200', patchViaRoster.statusCode === 200);
    ok('PATCH /api/roster writes Confirme', patchViaRoster.body?.data?.status === 'Confirme');

    const invalid = await postStatus('not-a-status');
    ok('POST /api/update-status rejects invalid status with 400', invalid.statusCode === 400);
    ok('invalid status uses VALIDATION_ERROR', invalid.body?.code === 'VALIDATION_ERROR');

    const foreignToken = signJwt(
      {
        sub: '00000000-0000-4000-8000-000000000099',
        role: 'assistant',
        clinic_id: '00000000-0000-4000-8000-000000000001',
        slug: 'other-clinic',
      },
      process.env.JWT_SECRET
    );
    const crossClinic = await postStatus('en_salle', { cookie: cookieHeader(foreignToken) });
    ok(
      'cross-clinic status mutation returns 403 or 404',
      crossClinic.statusCode === 403 || crossClinic.statusCode === 404,
      `status=${crossClinic.statusCode}`
    );

    const cancelled = await postStatus('Annulé');
    ok('POST /api/update-status Annulé returns 200', cancelled.statusCode === 200);
    ok('annule writes Annule', cancelled.body?.data?.status === 'Annule');
    ok('annule sets triggerCalCancel', cancelled.body?.triggerCalCancel === true);
  } finally {
    if (statusBookingId) {
      await query('DELETE FROM bookings WHERE id = $1', [statusBookingId]);
    }
  }

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
    handleAuth,
    createReq({
      method: 'POST',
      url: '/api/auth/password',
      headers: { 'content-type': 'application/json' },
      body: { currentPassword: SEED_PASSWORD, newPassword: 'abcdefgh' },
    })
  );
  ok('POST /api/auth/password without cookie returns 401', missingSession.statusCode === 401);

  const shortPwd = await invoke(
    handleAuth,
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
    handleAuth,
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
      handleAuth,
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
  const handleCal = require(path.join(DASHBOARD, 'api/webhooks/cal.js'));
  const calUid = `cal-wave2-${Date.now()}`;
  const createdStart = '2026-09-10T09:00:00.000Z';
  const rescheduledStart = '2026-09-10T11:30:00.000Z';

  const pingBody = { triggerEvent: 'PING' };
  const ping = await invoke(
    handleCal,
    createReq({
      method: 'POST',
      url: '/api/webhooks/cal',
      headers: calWebhookHeaders(pingBody),
      body: pingBody,
    })
  );
  ok('POST /api/webhooks/cal PING returns 200', ping.statusCode === 200, `status=${ping.statusCode}`);
  ok('Cal webhook PING ok:true', ping.body?.ok === true);

  const missingUidBody = { triggerEvent: 'BOOKING_CREATED' };
  const missingUid = await invoke(
    handleCal,
    createReq({
      method: 'POST',
      url: '/api/webhooks/cal',
      headers: calWebhookHeaders(missingUidBody),
      body: missingUidBody,
    })
  );
  ok('POST /api/webhooks/cal BOOKING_CREATED without uid returns 400', missingUid.statusCode === 400);

  try {
    const createdBody = {
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: calUid,
        startTime: createdStart,
        title: 'Consultation',
        organizer: { name: 'Dr. Shabi' },
        responses: {
          name: { value: 'Patient Cal Wave2' },
          email: { value: 'patient.cal@example.com' },
          phone: { value: '0612345678' },
        },
        attendees: [
          {
            name: 'Patient Cal Wave2',
            email: 'patient.cal@example.com',
            phoneNumber: '0612345678',
          },
        ],
      },
    };
    const created = await invoke(
      handleCal,
      createReq({
        method: 'POST',
        url: '/api/webhooks/cal',
        headers: calWebhookHeaders(createdBody),
        body: createdBody,
      })
    );
    ok(
      'POST /api/webhooks/cal BOOKING_CREATED returns 200',
      created.statusCode === 200,
      `status=${created.statusCode} body=${JSON.stringify(created.body)}`
    );
    ok('BOOKING_CREATED ok:true', created.body?.ok === true);
    ok('BOOKING_CREATED action is BOOKING_CREATED', created.body?.action === 'BOOKING_CREATED');
    ok('BOOKING_CREATED returns bookingId', Boolean(created.body?.bookingId));

    const createdRow = await query(
      `SELECT id, patient_name, patient_phone, treatment_name, status::text AS status, starts_at
       FROM bookings WHERE cal_booking_uid = $1 LIMIT 1`,
      [calUid]
    );
    const inserted = createdRow.rows[0];
    ok('BOOKING_CREATED inserted a bookings row', Boolean(inserted));
    ok('BOOKING_CREATED patient_name is stored', inserted?.patient_name === 'Patient Cal Wave2');
    ok('BOOKING_CREATED status is Confirme', inserted?.status === 'Confirme');
    ok(
      'BOOKING_CREATED starts_at matches payload',
      inserted && new Date(inserted.starts_at).toISOString() === createdStart,
      `starts_at=${inserted?.starts_at}`
    );

    const rescheduledBody = {
      type: 'BOOKING_RESCHEDULED',
      payload: {
        uid: calUid,
        startTime: rescheduledStart,
      },
    };
    const rescheduled = await invoke(
      handleCal,
      createReq({
        method: 'POST',
        url: '/api/webhooks/cal',
        headers: calWebhookHeaders(rescheduledBody),
        body: rescheduledBody,
      })
    );
    ok('POST /api/webhooks/cal BOOKING_RESCHEDULED returns 200', rescheduled.statusCode === 200);
    ok('BOOKING_RESCHEDULED action is BOOKING_RESCHEDULED', rescheduled.body?.action === 'BOOKING_RESCHEDULED');

    const moved = await query(
      `SELECT status::text AS status, starts_at FROM bookings WHERE cal_booking_uid = $1 LIMIT 1`,
      [calUid]
    );
    ok(
      'BOOKING_RESCHEDULED updates starts_at',
      moved.rows[0] && new Date(moved.rows[0].starts_at).toISOString() === rescheduledStart,
      `starts_at=${moved.rows[0]?.starts_at}`
    );
    ok('BOOKING_RESCHEDULED keeps status Confirme', moved.rows[0]?.status === 'Confirme');

    const cancelledBody = {
      triggerEvent: 'BOOKING_CANCELLED',
      payload: { uid: calUid },
    };
    const cancelled = await invoke(
      handleCal,
      createReq({
        method: 'POST',
        url: '/api/webhooks/cal',
        headers: calWebhookHeaders(cancelledBody),
        body: cancelledBody,
      })
    );
    ok('POST /api/webhooks/cal BOOKING_CANCELLED returns 200', cancelled.statusCode === 200);
    ok('BOOKING_CANCELLED action is BOOKING_CANCELLED', cancelled.body?.action === 'BOOKING_CANCELLED');

    const cancelledRow = await query(
      `SELECT status::text AS status FROM bookings WHERE cal_booking_uid = $1 LIMIT 1`,
      [calUid]
    );
    ok('BOOKING_CANCELLED status is Annule', cancelledRow.rows[0]?.status === 'Annule');
  } finally {
    await query('DELETE FROM bookings WHERE cal_booking_uid = $1', [calUid]);
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
