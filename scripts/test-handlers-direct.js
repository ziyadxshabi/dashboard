#!/usr/bin/env node
/**
 * Direct handler tests against local PostgreSQL.
 * Loads Temara_Dashboard/.env.local, invokes serverless handlers with a
 * Vercel-compatible (req, res) shim, and asserts the Wave 1–3 API contracts.
 *
 * Seeded credentials: docteur / dentaflow, assistante / dentaflow, clinic slug temara.
 * Auth cookie: dentaflow_session.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

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
const handleTeamNotes = require(path.join(DASHBOARD, 'api/team-notes.js'));
const handleFillGap = require(path.join(DASHBOARD, 'api/fill-gap.js'));
const handleBulkSms = require(path.join(DASHBOARD, 'api/bulk-sms.js'));
const handleTwilio = require(path.join(DASHBOARD, 'api/webhooks/twilio.js'));
const { query } = require(path.join(DASHBOARD, 'api/_lib/db.js'));
const { hashPassword, verifyPassword, signJwt } = require(path.join(DASHBOARD, 'api/_lib/auth-crypto.js'));
const { toE164MA, isValidMaMobileE164 } = require(path.join(DASHBOARD, 'api/_lib/phone-e164.js'));
const { waitlistRank, pickWaitlistTopN, blastWaitlistSlot } = require(path.join(DASHBOARD, 'api/_lib/waitlist-blast.js'));
const { inReminderWindow, daysBetweenCasablanca, inUnconfirmedWindow } = require(path.join(DASHBOARD, 'api/_lib/cron-notify.js'));
const { tryAcquireLock } = require(path.join(DASHBOARD, 'api/_lib/notification-locks.js'));
const {
  verifyTwilioSignature,
  timingSafeEqualStrings,
  sendTwilioMessage,
  formatWhatsappAddress,
  stripWhatsappPrefix,
} = require(path.join(DASHBOARD, 'api/_lib/twilio.js'));
const { sanitizeString } = require(path.join(DASHBOARD, 'api/_lib/validation.js'));
const templates = require(path.join(DASHBOARD, 'api/_lib/sms-templates.js'));
const { expectedCopayMad } = require(path.join(DASHBOARD, 'api/_lib/treatments.js'));

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

const FLOOR_OPS_PHONES = ['0655510001', '0655510002', '0655510003', '0655510004', '0655510005'];
const FLOOR_OPS_NAMES = ['Nadia Floor', 'Omar Floor', 'Walkin Floor', 'Urgence Relachee', 'Docteur Visit'];

async function cleanupFloorOpsBookings() {
  await query(
    `DELETE FROM recalls
     WHERE source_booking_id IN (
       SELECT id FROM bookings
       WHERE patient_phone = ANY($1::text[])
          OR patient_name = ANY($2::text[])
     )
        OR patient_name = ANY($2::text[])`,
    [FLOOR_OPS_PHONES, FLOOR_OPS_NAMES]
  );
  await query(
    `DELETE FROM bookings
     WHERE patient_phone = ANY($1::text[])
        OR patient_name = ANY($2::text[])`,
    [FLOOR_OPS_PHONES, FLOOR_OPS_NAMES]
  );
}

function casablancaHourNow() {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Casablanca',
      hour: '2-digit',
      hour12: false,
    }).format(new Date())
  );
}

async function pauseOverlappingBookings(clinicId, startsAt, durationMin = 20, bufferMin = 10) {
  const overlapping = await query(
    `SELECT id, status::text AS status
     FROM bookings
     WHERE clinic_id = $1
       AND status::text NOT IN ('Annule', 'No-show')
       AND public.booking_busy_range(starts_at, duration_min, buffer_min)
           && public.booking_busy_range($2::timestamptz, $3::int, $4::int)`,
    [clinicId, startsAt, durationMin, bufferMin]
  );
  const rows = overlapping.rows || [];
  if (rows.length) {
    await query(`UPDATE bookings SET status = 'Annule' WHERE id = ANY($1::uuid[])`, [
      rows.map((row) => row.id),
    ]);
  }
  return rows;
}

async function restorePausedBookings(rows) {
  const seen = new Set();
  for (const row of rows || []) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    await query(`UPDATE bookings SET status = $2::appointment_status WHERE id = $1`, [
      row.id,
      row.status,
    ]);
  }
}

async function run() {
  console.log('\n== Direct handler tests (PostgreSQL) ==\n');

  console.log('[frontend contracts]');
  const authSrc = fs.readFileSync(path.join(DASHBOARD, 'auth.js'), 'utf8');
  const dashSrc = fs.readFileSync(path.join(DASHBOARD, 'dashboard_app.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(DASHBOARD, 'app.js'), 'utf8');
  const themeBootSrc = fs.readFileSync(path.join(DASHBOARD, 'theme-boot.js'), 'utf8');
  ok('auth.js does not define SESSION_TOKEN_KEY', !/\bSESSION_TOKEN_KEY\b/.test(authSrc));
  ok('auth.js serializes cookie restore', /\brestoreInflight\b/.test(authSrc) && /\bensureSessionRestored\b/.test(authSrc));
  ok('auth.js requireSession awaits restore', /async function requireSession/.test(authSrc));
  ok(
    'dashboard_app.js has no Cal booking wizard stub',
    !/\binitClientBooking\b/.test(dashSrc) && !/\bBOOKING_STATE\b/.test(dashSrc)
  );
  ok(
    'dashboard_app.js has no #reserver client portal',
    !/#reserver/.test(dashSrc) && !/\benterClientPortal\b/.test(dashSrc)
  );
  ok('app.js does not use demoStorage names', !/\bdemoStorage(Get|Set)\b/.test(appSrc));
  ok(
    'app.js maps Planning and Transmissions views',
    /planning:\s*'view-planning'/.test(appSrc) && /handoff:\s*'view-handoff'/.test(appSrc)
  );
  const assistantHtml = fs.readFileSync(path.join(DASHBOARD, 'assistant-shell.html'), 'utf8');
  const carnetSrc = fs.readFileSync(path.join(DASHBOARD, 'carnet.js'), 'utf8');
  ok('assistant-shell has Planning and Transmissions pages', /id="view-planning"/.test(assistantHtml) && /id="view-handoff"/.test(assistantHtml));
  ok(
    'assistant-shell Walk-in is a visible secondary button',
    /class="btn-matte-secondary" id="floor-walkin-btn"/.test(assistantHtml)
  );
  ok('carnet.js exposes shared DentaFlowCarnet', /DentaFlowCarnet/.test(carnetSrc) && /directory=1/.test(carnetSrc));
  const indexHtml = fs.readFileSync(path.join(DASHBOARD, 'index.html'), 'utf8');
  ok(
    'doctor CRM sheet lives inside #doctor-shell',
    /id="doctor-shell"[\s\S]*id="crm-side-panel"[\s\S]*id="assistant-shell"/.test(indexHtml)
  );
  ok(
    'login footer links privacy and terms pages',
    /href="\/privacy.html"/.test(indexHtml) && /href="\/terms.html"/.test(indexHtml)
  );
  const bookHtml = fs.readFileSync(path.join(DASHBOARD, 'book.html'), 'utf8');
  ok(
    'book.html discloses Cal.com, Twilio, and Loi 09-08',
    /Cal\.com/.test(bookHtml) && /Twilio/.test(bookHtml) && /Loi 09-08/.test(bookHtml)
  );
  ok('theme-boot.js reads dentaflow_assistant_prefs', /dentaflow_assistant_prefs/.test(themeBootSrc));
  ok('theme-boot.js migrates doctor_theme', /doctor_theme/.test(themeBootSrc));

  const themeStore = { doctor_theme: 'dark' };
  const themeDoc = { attr: 'pearl-clinic' };
  vm.runInNewContext(themeBootSrc, {
    localStorage: {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(themeStore, key) ? themeStore[key] : null;
      },
      setItem(key, value) {
        themeStore[key] = String(value);
      },
      removeItem(key) {
        delete themeStore[key];
      },
    },
    document: {
      documentElement: {
        setAttribute(name, value) {
          if (name === 'data-theme') themeDoc.attr = value;
        },
      },
    },
  });
  ok('theme-boot migrates doctor_theme=dark to oak-lounge', themeDoc.attr === 'oak-lounge');
  ok('theme-boot writes dentaflow_assistant_prefs.theme', /oak-lounge/.test(themeStore.dentaflow_assistant_prefs || ''));
  ok('theme-boot removes legacy doctor_theme', !Object.prototype.hasOwnProperty.call(themeStore, 'doctor_theme'));

  ok(
    'DATABASE_URL is configured',
    Boolean(String(process.env.DATABASE_URL || '').trim())
  );
  ok('JWT_SECRET is configured', Boolean(String(process.env.JWT_SECRET || '').trim()));

  const migrationSql = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260906_notification_sms.sql'),
    'utf8'
  );
  await query(migrationSql);
  ok('notification SMS migration applied', true);

  const roiMigrationSql = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260907_roi_loops.sql'),
    'utf8'
  );
  await query(roiMigrationSql);
  ok('ROI loops migration applied', true);

  const hoursMigrationSql = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260908_clinic_hours.sql'),
    'utf8'
  );
  await query(hoursMigrationSql);
  ok('clinic hours migration applied', true);

  const consentMigrationSql = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260910_sms_consent_optin.sql'),
    'utf8'
  );
  await query(consentMigrationSql);
  ok('SMS consent opt-in migration applied', true);
  await query(
    `UPDATE clinics
     SET day_start = '08:00', day_end = '19:00', sms_reminders_enabled = true
     WHERE slug = $1`,
    [CLINIC_SLUG]
  );

  const { findNextGap } = require(path.join(DASHBOARD, 'api/_lib/roster-ops.js'));
  const gapAfterClose = findNextGap({
    now: new Date('2026-09-08T17:30:00.000+01:00'),
    dateIso: '2026-09-08',
    durationMin: 30,
    bufferMin: 10,
    busyRows: [],
    openTime: '08:00',
    closeTime: '18:00',
  });
  ok('findNextGap returns null after day_end', gapAfterClose == null);
  const gapExtendedHours = findNextGap({
    now: new Date('2026-09-08T17:30:00.000+01:00'),
    dateIso: '2026-09-08',
    durationMin: 30,
    bufferMin: 10,
    busyRows: [],
    openTime: '08:00',
    closeTime: '20:00',
  });
  ok('findNextGap uses extended day_end', Boolean(gapExtendedHours?.startsAt));

  await query(
    `UPDATE clinics
     SET cal_event_type_id = COALESCE(NULLIF(btrim(cal_event_type_id), ''), 'dentaflow/temara')
     WHERE slug = $1`,
    [CLINIC_SLUG]
  );

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

  const notesAnon = await invoke(handleTeamNotes, createReq({ method: 'GET', url: '/api/team-notes', headers: {} }));
  ok('GET /api/team-notes without cookie returns 401', notesAnon.statusCode === 401);

  const fillGapAnon = await invoke(handleFillGap, createReq({ method: 'POST', url: '/api/fill-gap', headers: {}, body: {} }));
  ok('POST /api/fill-gap without cookie returns 401', fillGapAnon.statusCode === 401);

  const bulkSmsAnon = await invoke(handleBulkSms, createReq({ method: 'POST', url: '/api/bulk-sms', headers: {}, body: {} }));
  ok('POST /api/bulk-sms without cookie returns 401', bulkSmsAnon.statusCode === 401);

  const meAnon = await invoke(handleAuth, createReq({ method: 'GET', url: '/api/auth/me', headers: {} }));
  ok('GET /api/auth/me without cookie returns 401', meAnon.statusCode === 401);

  const savedJwtSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    const meAnonNoSecret = await invoke(
      handleAuth,
      createReq({ method: 'GET', url: '/api/auth/me', headers: {} })
    );
    ok(
      'GET /api/auth/me without cookie still returns 401 when JWT_SECRET is unset',
      meAnonNoSecret.statusCode === 401,
      `status=${meAnonNoSecret.statusCode}`
    );

    const meCookieNoSecret = await invoke(
      handleAuth,
      createReq({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: 'dentaflow_session=stale' },
      })
    );
    ok(
      'GET /api/auth/me with cookie returns 503 when JWT_SECRET is unset',
      meCookieNoSecret.statusCode === 503,
      `status=${meCookieNoSecret.statusCode}`
    );

    const loginNoSecret = await invoke(
      handleAuth,
      createReq({
        method: 'POST',
        url: '/api/auth',
        headers: { 'content-type': 'application/json' },
        body: { username: DOCTOR_USER, password: SEED_PASSWORD, slug: CLINIC_SLUG },
      })
    );
    ok(
      'POST /api/auth returns 503 when JWT_SECRET is unset',
      loginNoSecret.statusCode === 503,
      `status=${loginNoSecret.statusCode}`
    );
  } finally {
    if (savedJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedJwtSecret;
  }

  // ── Roster (Postgres) ──────────────────────────────────────────────────
  console.log('\n[roster]');
  const roster = await invoke(
    handleRoster,
    createReq({ method: 'GET', url: '/api/roster', headers: doctorCookie })
  );
  ok('GET /api/roster authenticated returns 200', roster.statusCode === 200, `status=${roster.statusCode}`);
  ok('GET /api/roster ok:true', roster.body?.ok === true);
  ok('GET /api/roster data is an array', Array.isArray(roster.body?.data));
  ok(
    'GET /api/roster rows use patient_name',
    (roster.body?.data || []).every((row) => row && typeof row === 'object' && 'patient_name' in row)
      || (roster.body?.data || []).length === 0
  );
  ok(
    'GET /api/roster does not emit French Patient (Nom Complet)',
    (roster.body?.data || []).every((row) => !Object.prototype.hasOwnProperty.call(row, 'Patient (Nom Complet)'))
  );

  const rosterClinic = await query('SELECT id FROM clinics WHERE slug = $1 LIMIT 1', [CLINIC_SLUG]);
  const rosterClinicId = rosterClinic.rows[0]?.id;
  ok('temara clinic id is available for roster range tests', Boolean(rosterClinicId));

  const rosterRangeIds = [];
  try {
    const bounds = await query(`
      SELECT
        (NOW() AT TIME ZONE 'Africa/Casablanca')::date::text AS today,
        ((NOW() AT TIME ZONE 'Africa/Casablanca')::date - 1)::text AS yesterday,
        ((NOW() AT TIME ZONE 'Africa/Casablanca')::date + 1)::text AS tomorrow
    `);
    const todayIso = bounds.rows[0]?.today;
    const yesterdayIso = bounds.rows[0]?.yesterday;
    const tomorrowIso = bounds.rows[0]?.tomorrow;

    await query(
      `DELETE FROM bookings
       WHERE clinic_id = $1
         AND patient_name IN ('Roster Today Apple', 'Roster Tomorrow Apple')`,
      [rosterClinicId]
    );

    const inserted = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status, starts_at, duration_min
       ) VALUES
         ($1, 'Roster Today Apple', '0600000091', 'Detartrage', 'Confirme'::appointment_status,
          ((NOW() AT TIME ZONE 'Africa/Casablanca')::date + TIME '06:11') AT TIME ZONE 'Africa/Casablanca', 30),
         ($1, 'Roster Tomorrow Apple', '0600000092', 'Controle', 'Confirme'::appointment_status,
          ((NOW() AT TIME ZONE 'Africa/Casablanca')::date + 1 + TIME '06:12') AT TIME ZONE 'Africa/Casablanca', 30)
       RETURNING id`,
      [rosterClinicId]
    );
    inserted.rows.forEach((row) => rosterRangeIds.push(row.id));

    const rosterToday = await invoke(
      handleRoster,
      createReq({ method: 'GET', url: '/api/roster', headers: doctorCookie })
    );
    const todayNames = (rosterToday.body?.data || []).map((row) => row.patient_name);
    ok(
      'default GET /api/roster includes today booking',
      todayNames.includes('Roster Today Apple'),
      JSON.stringify(todayNames)
    );
    ok(
      'default GET /api/roster stays today-only',
      !todayNames.includes('Roster Tomorrow Apple'),
      JSON.stringify(todayNames)
    );

    const rosterRange = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: `/api/roster?from=${yesterdayIso}&to=${tomorrowIso}`,
        headers: doctorCookie,
      })
    );
    const rangeNames = (rosterRange.body?.data || []).map((row) => row.patient_name);
    ok('ranged GET /api/roster returns 200', rosterRange.statusCode === 200, `status=${rosterRange.statusCode}`);
    ok(
      'ranged GET /api/roster includes in-window rows',
      rangeNames.includes('Roster Today Apple') && rangeNames.includes('Roster Tomorrow Apple'),
      JSON.stringify(rangeNames)
    );

    const missingTo = await invoke(
      handleRoster,
      createReq({ method: 'GET', url: `/api/roster?from=${todayIso}`, headers: doctorCookie })
    );
    ok('GET /api/roster from without to returns 400', missingTo.statusCode === 400);

    const inverted = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: `/api/roster?from=${tomorrowIso}&to=${yesterdayIso}`,
        headers: doctorCookie,
      })
    );
    ok('GET /api/roster inverted range returns 400', inverted.statusCode === 400);

    const invalidDate = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?from=2026-02-31&to=2026-03-01',
        headers: doctorCookie,
      })
    );
    ok('GET /api/roster invalid calendar date returns 400', invalidDate.statusCode === 400);

    const tooWide = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?from=2026-01-01&to=2026-03-01',
        headers: doctorCookie,
      })
    );
    ok('GET /api/roster range over 42 days returns 400', tooWide.statusCode === 400);

    const rosterSearch = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?q=Roster%20Today%20Apple',
        headers: doctorCookie,
      })
    );
    const searchNames = (rosterSearch.body?.data || []).map((row) => row.patient_name);
    ok('GET /api/roster?q= returns 200', rosterSearch.statusCode === 200, `status=${rosterSearch.statusCode}`);
    ok(
      'GET /api/roster?q= matches patient name in 90-day window',
      searchNames.includes('Roster Today Apple'),
      JSON.stringify(searchNames)
    );

    const rosterPhoneSearch = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?q=0600000091',
        headers: doctorCookie,
      })
    );
    ok(
      'GET /api/roster?q= matches phone',
      (rosterPhoneSearch.body?.data || []).some((row) => row.patient_phone === '0600000091'),
      JSON.stringify(rosterPhoneSearch.body?.data)
    );
  } finally {
    await query('DELETE FROM bookings WHERE id = ANY($1::uuid[])', [rosterRangeIds]);
  }

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
    await query(
      `DELETE FROM bookings WHERE clinic_id = $1 AND patient_name = 'Patient Test R13 Status'`,
      [clinicId]
    );
    const inserted = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status, starts_at, duration_min
       ) VALUES (
         $1, $2, $3, $4, 'Confirme'::appointment_status,
         ((NOW() AT TIME ZONE 'Africa/Casablanca')::date + TIME '03:17') AT TIME ZONE 'Africa/Casablanca',
         30
       )
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
    ok('en_soin stamps care_started_at', Boolean(toSoin.body?.data?.care_started_at));

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

    const doctorStatus = await postStatus('en_salle', doctorCookie);
    ok('POST /api/update-status as doctor returns 403', doctorStatus.statusCode === 403);

    const missingReason = await postStatus('Annulé');
    ok('POST /api/update-status Annulé without cancel_reason returns 400', missingReason.statusCode === 400);

    const cancelled = await invoke(
      handleUpdateStatus,
      createReq({
        method: 'POST',
        url: '/api/update-status',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { bookingId: statusBookingId, newStatus: 'Annulé', cancelReason: 'oublie' },
      })
    );
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
        consent_sms: true,
      },
    })
  );
  ok('POST /api/waitlist returns 200', waitlistPost.statusCode === 200, `status=${waitlistPost.statusCode} body=${JSON.stringify(waitlistPost.body)}`);
  ok('POST /api/waitlist ok:true', waitlistPost.body?.ok === true);
  ok('POST /api/waitlist returns id', Boolean(waitlistPost.body?.id));

  if (waitlistPost.body?.id) {
    const consentRow = await query(
      `SELECT sms_consent, consent_at FROM waitlist WHERE id = $1`,
      [waitlistPost.body.id]
    );
    ok('POST /api/waitlist consent true persists sms_consent', consentRow.rows[0]?.sms_consent === true);
    ok('POST /api/waitlist consent true persists consent_at', Boolean(consentRow.rows[0]?.consent_at));
  }

  const waitlistOmitConsent = await invoke(
    handleWaitlist,
    createReq({
      method: 'POST',
      url: '/api/waitlist',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: {
        nom: 'Sans Consentement',
        telephone: '0612345679',
        priorite: 'Haute',
      },
    })
  );
  ok(
    'POST /api/waitlist omit consent returns 400',
    waitlistOmitConsent.statusCode === 400,
    `status=${waitlistOmitConsent.statusCode}`
  );

  const noSmsName = `NoSms ${Date.now()}`;
  const waitlistNoSms = await invoke(
    handleWaitlist,
    createReq({
      method: 'POST',
      url: '/api/waitlist',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: {
        nom: noSmsName,
        telephone: '0612987654',
        priorite: 'Urgent',
        consent_sms: false,
      },
    })
  );
  ok('POST /api/waitlist consent false returns 200', waitlistNoSms.statusCode === 200 && Boolean(waitlistNoSms.body?.id));
  if (waitlistNoSms.body?.id) {
    const noSmsRow = await query(
      `SELECT sms_consent, consent_at FROM waitlist WHERE id = $1`,
      [waitlistNoSms.body.id]
    );
    ok('POST /api/waitlist consent false stores false', noSmsRow.rows[0]?.sms_consent === false);
    ok('POST /api/waitlist consent false leaves consent_at null', noSmsRow.rows[0]?.consent_at == null);
    const others = await query(
      `SELECT id FROM waitlist WHERE clinic_id = $1 AND status = 'active' AND id <> $2`,
      [clinicId, waitlistNoSms.body.id]
    );
    const blast = await blastWaitlistSlot(clinicId, createReq({ method: 'POST', url: '/api/waitlist' }), {
      topN: 1,
      excludeIds: others.rows.map((row) => row.id),
      batchId: `consent-test-${Date.now()}`,
    });
    const skippedNoConsent = (blast.skipped || []).some(
      (row) => String(row.id) === String(waitlistNoSms.body.id) && row.reason === 'no_consent'
    );
    ok('waitlist blast skips sms_consent false', skippedNoConsent, JSON.stringify(blast.skipped || []));
    await query('DELETE FROM waitlist WHERE id = $1', [waitlistNoSms.body.id]);
  }

  const waitlistAfter = await invoke(
    handleWaitlist,
    createReq({ method: 'GET', url: '/api/waitlist', headers: assistantCookie })
  );
  const found = (waitlistAfter.body?.data || []).some((row) => row.nom === patientName || row.patient_name === patientName);
  ok('GET /api/waitlist includes the inserted patient', found);

  const waitlistOrderIds = [];
  try {
    const low = await query(
      `INSERT INTO waitlist (clinic_id, patient_name, patient_phone, priority, notes, status)
       VALUES ($1, $2, $3, 'Faible'::waitlist_priority, '', 'active')
       RETURNING id`,
      [rosterClinicId, `WaitLow ${Date.now()}`, '0611111111']
    );
    const urgent = await query(
      `INSERT INTO waitlist (clinic_id, patient_name, patient_phone, priority, notes, status)
       VALUES ($1, $2, $3, 'Urgent'::waitlist_priority, '', 'active')
       RETURNING id`,
      [rosterClinicId, `WaitUrgent ${Date.now()}`, '0622222222']
    );
    waitlistOrderIds.push(low.rows[0]?.id, urgent.rows[0]?.id);
    const ordered = await invoke(
      handleWaitlist,
      createReq({ method: 'GET', url: '/api/waitlist', headers: assistantCookie })
    );
    const names = (ordered.body?.data || []).map((row) => row.patient_name || row.nom);
    const urgentIdx = names.findIndex((name) => String(name).startsWith('WaitUrgent'));
    const lowIdx = names.findIndex((name) => String(name).startsWith('WaitLow'));
    ok(
      'GET /api/waitlist lists Urgent before Faible',
      urgentIdx >= 0 && lowIdx >= 0 && urgentIdx < lowIdx,
      JSON.stringify({ urgentIdx, lowIdx, names: names.slice(0, 8) })
    );
  } finally {
    if (waitlistOrderIds.length) {
      await query('DELETE FROM waitlist WHERE id = ANY($1::uuid[])', [waitlistOrderIds.filter(Boolean)]);
    }
  }

  if (waitlistPost.body?.id) {
    await query('DELETE FROM waitlist WHERE id = $1', [waitlistPost.body.id]);
  }

  // ── Team notes (Postgres) ──────────────────────────────────────────────
  console.log('\n[team-notes]');

  const notesGet = await invoke(
    handleTeamNotes,
    createReq({ method: 'GET', url: '/api/team-notes', headers: assistantCookie })
  );
  ok('GET /api/team-notes authenticated returns 200', notesGet.statusCode === 200, `status=${notesGet.statusCode} body=${JSON.stringify(notesGet.body)}`);
  ok('GET /api/team-notes ok:true', notesGet.body?.ok === true);
  ok('GET /api/team-notes data is an array', Array.isArray(notesGet.body?.data));

  const notesGetDoctor = await invoke(
    handleTeamNotes,
    createReq({ method: 'GET', url: '/api/team-notes', headers: doctorCookie })
  );
  ok('GET /api/team-notes as doctor returns 200', notesGetDoctor.statusCode === 200, `status=${notesGetDoctor.statusCode}`);

  const noteMarker = `wave2-note-${Date.now()}`;
  let insertedNoteId = null;
  try {
    const notesPost = await invoke(
      handleTeamNotes,
      createReq({
        method: 'POST',
        url: '/api/team-notes',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          text: noteMarker,
          category: 'general',
          pinned: true,
          author: 'Assistante Test',
        },
      })
    );
    ok(
      'POST /api/team-notes returns 200',
      notesPost.statusCode === 200,
      `status=${notesPost.statusCode} body=${JSON.stringify(notesPost.body)}`
    );
    ok('POST /api/team-notes ok:true', notesPost.body?.ok === true);
    ok('POST /api/team-notes returns newNote id', Boolean(notesPost.body?.data?.id));
    ok(
      'POST /api/team-notes persists message',
      notesPost.body?.data?.message === noteMarker,
      `message=${notesPost.body?.data?.message}`
    );
    ok('POST /api/team-notes pinned is true', notesPost.body?.data?.pinned === true);
    insertedNoteId = notesPost.body?.data?.id || null;

    let visitNoteId = null;
    const bookingForNote = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status, starts_at, duration_min
       ) VALUES (
         $1, 'Note Visit Patient', '0633333333', 'Controle', 'Confirme'::appointment_status,
         ((NOW() AT TIME ZONE 'Africa/Casablanca')::date + TIME '03:41') AT TIME ZONE 'Africa/Casablanca', 30
       ) RETURNING id`,
      [rosterClinicId]
    );
    const visitBookingId = bookingForNote.rows[0]?.id;
    try {
      const visitNote = await invoke(
        handleTeamNotes,
        createReq({
          method: 'POST',
          url: '/api/team-notes',
          headers: { ...assistantCookie, 'content-type': 'application/json' },
          body: {
            text: `visit-note-${Date.now()}`,
            category: 'Planning',
            bookingId: visitBookingId,
            patientName: 'Note Visit Patient',
          },
        })
      );
      ok(
        'POST /api/team-notes with bookingId returns 200',
        visitNote.statusCode === 200,
        `status=${visitNote.statusCode} body=${JSON.stringify(visitNote.body)}`
      );
      visitNoteId = visitNote.body?.data?.id || null;
      ok(
        'POST /api/team-notes echoes booking_id',
        visitNote.body?.data?.booking_id === String(visitBookingId) || visitNote.body?.data?.bookingId === String(visitBookingId),
        JSON.stringify(visitNote.body?.data)
      );
      ok(
        'POST /api/team-notes echoes patient_name',
        visitNote.body?.data?.patient_name === 'Note Visit Patient',
        `patient_name=${visitNote.body?.data?.patient_name}`
      );

      const notesWithVisit = await invoke(
        handleTeamNotes,
        createReq({ method: 'GET', url: '/api/team-notes', headers: doctorCookie })
      );
      const foundVisit = (notesWithVisit.body?.data || []).some(
        (row) => row.id === visitNoteId && (row.booking_id === String(visitBookingId) || row.patient_name === 'Note Visit Patient')
      );
      ok('GET /api/team-notes includes booking_id for visit notes', foundVisit);
    } finally {
      if (visitNoteId) await query('DELETE FROM team_notes WHERE id = $1', [visitNoteId]);
      if (visitBookingId) await query('DELETE FROM bookings WHERE id = $1', [visitBookingId]);
    }

    const notesAfter = await invoke(
      handleTeamNotes,
      createReq({ method: 'GET', url: '/api/team-notes', headers: assistantCookie })
    );
    const persisted = (notesAfter.body?.data || []).some(
      (row) => row.id === insertedNoteId || row.message === noteMarker || row.text === noteMarker
    );
    ok('GET /api/team-notes includes the inserted note', persisted);
  } finally {
    if (insertedNoteId) {
      await query('DELETE FROM team_notes WHERE id = $1', [insertedNoteId]);
    }
  }

  const notesEmpty = await invoke(
    handleTeamNotes,
    createReq({
      method: 'POST',
      url: '/api/team-notes',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: {},
    })
  );
  ok('POST /api/team-notes empty body returns 400', notesEmpty.statusCode === 400);

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

  // ── Fill-gap (Postgres waitlist → bookings) ────────────────────────────
  console.log('\n[fill-gap]');
  const fillGapName = `FillGap ${Date.now()}`;
  let fillGapWaitlistId = null;
  let fillGapBookingId = null;
  try {
    const wl = await query(
      `INSERT INTO waitlist (clinic_id, patient_name, patient_phone, priority, notes, status)
       VALUES ($1, $2, $3, 'Urgent'::waitlist_priority, $4, 'active')
       RETURNING id`,
      [clinicId, fillGapName, '0612345678', 'wave3-fill-gap']
    );
    fillGapWaitlistId = wl.rows[0]?.id;
    ok('inserted Urgent waitlist candidate for fill-gap', Boolean(fillGapWaitlistId));

    const fillList = await invoke(
      handleFillGap,
      createReq({
        method: 'POST',
        url: '/api/fill-gap',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { slotDate: '2026-12-18', slotTime: '07:15', reason: 'Trou dans le planning' },
      })
    );
    ok(
      'POST /api/fill-gap returns 200',
      fillList.statusCode === 200,
      `status=${fillList.statusCode} body=${JSON.stringify(fillList.body)}`
    );
    ok('POST /api/fill-gap ok:true', fillList.body?.ok === true);
    ok('POST /api/fill-gap data.candidates is an array', Array.isArray(fillList.body?.data?.candidates));
    ok(
      'POST /api/fill-gap lists the waitlist candidate',
      (fillList.body?.data?.candidates || []).some((row) => row.id === fillGapWaitlistId || row.patient_name === fillGapName)
    );
    ok('POST /api/fill-gap booking is null until a candidate is selected', fillList.body?.data?.booking == null);

    const fillBook = await invoke(
      handleFillGap,
      createReq({
        method: 'POST',
        url: '/api/fill-gap',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          slotDate: '2026-12-18',
          slotTime: '07:15',
          reason: 'Consultation',
          candidateId: fillGapWaitlistId,
        },
      })
    );
    ok(
      'POST /api/fill-gap with candidateId returns 201/200',
      fillBook.statusCode === 201 || fillBook.statusCode === 200,
      `status=${fillBook.statusCode} body=${JSON.stringify(fillBook.body)}`
    );
    ok('POST /api/fill-gap inserts a booking', Boolean(fillBook.body?.data?.booking?.id));
    ok('POST /api/fill-gap booking status is en_attente', fillBook.body?.data?.booking?.status === 'en_attente');
    fillGapBookingId = fillBook.body?.data?.booking?.id || null;

    if (fillGapBookingId) {
      const booked = await query(
        `SELECT patient_name, status::text AS status, patient_id FROM bookings WHERE id = $1`,
        [fillGapBookingId]
      );
      ok('fill-gap booking persisted in bookings', booked.rows[0]?.patient_name === fillGapName);
      ok('fill-gap booking DB status is En attente', booked.rows[0]?.status === 'En attente');
      ok('fill-gap booking attaches patient_id', Boolean(booked.rows[0]?.patient_id));
    }
    const filledRow = await query(`SELECT status FROM waitlist WHERE id = $1`, [fillGapWaitlistId]);
    ok('fill-gap marks waitlist filled', filledRow.rows[0]?.status === 'filled');
  } finally {
    if (fillGapBookingId) await query('DELETE FROM bookings WHERE id = $1', [fillGapBookingId]);
    if (fillGapWaitlistId) await query('DELETE FROM waitlist WHERE id = $1', [fillGapWaitlistId]);
  }

  const fillGapBadDate = await invoke(
    handleFillGap,
    createReq({
      method: 'POST',
      url: '/api/fill-gap',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: { slotDate: 'not-a-date', slotTime: '10:30' },
    })
  );
  ok('POST /api/fill-gap rejects invalid slotDate with 400', fillGapBadDate.statusCode === 400);

  const fillGapDoctor = await invoke(
    handleFillGap,
    createReq({
      method: 'POST',
      url: '/api/fill-gap',
      headers: { ...doctorCookie, 'content-type': 'application/json' },
      body: { slotDate: '2026-12-18', slotTime: '07:15' },
    })
  );
  ok('POST /api/fill-gap as doctor returns 403', fillGapDoctor.statusCode === 403);

  // ── Bulk SMS audit (Postgres) ──────────────────────────────────────────
  console.log('\n[bulk-sms]');
  const bulkEmpty = await invoke(
    handleBulkSms,
    createReq({
      method: 'POST',
      url: '/api/bulk-sms',
      headers: { ...doctorCookie, 'content-type': 'application/json' },
      body: { customMessage: 'Rappel de rendez-vous demain.' },
    })
  );
  ok('POST /api/bulk-sms empty recipients returns 400', bulkEmpty.statusCode === 400);
  ok('POST /api/bulk-sms empty recipients uses VALIDATION_ERROR', bulkEmpty.body?.code === 'VALIDATION_ERROR');

  const bulkShort = await invoke(
    handleBulkSms,
    createReq({
      method: 'POST',
      url: '/api/bulk-sms',
      headers: { ...doctorCookie, 'content-type': 'application/json' },
      body: { customMessage: 'ab', recipients: ['0612345678'] },
    })
  );
  ok('POST /api/bulk-sms short message returns 400', bulkShort.statusCode === 400);

  let bulkAuditId = null;
  try {
    const bulkOk = await invoke(
      handleBulkSms,
      createReq({
        method: 'POST',
        url: '/api/bulk-sms',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          customMessage: 'Rappel: rendez-vous demain a 10h.',
          recipients: ['0612345678', '0612987654'],
        },
      })
    );
    ok(
      'POST /api/bulk-sms valid array returns 200',
      bulkOk.statusCode === 200,
      `status=${bulkOk.statusCode} body=${JSON.stringify(bulkOk.body)}`
    );
    ok('POST /api/bulk-sms ok:true', bulkOk.body?.ok === true);
    ok(
      'POST /api/bulk-sms does not fake dispatchedCount without Twilio SID',
      bulkOk.body?.dispatchedCount === 0,
      `dispatchedCount=${bulkOk.body?.dispatchedCount}`
    );
    ok('POST /api/bulk-sms twilioConfigured is false in this env', bulkOk.body?.twilioConfigured === false);
    ok(
      'POST /api/bulk-sms skipped invalid-or-unsent recipients',
      Array.isArray(bulkOk.body?.skipped) && bulkOk.body.skipped.length === 2
    );
    ok(
      'POST /api/bulk-sms returns sanitized message',
      typeof bulkOk.body?.message === 'string' && bulkOk.body.message.length >= 3
    );

    const audit = await query(
      `SELECT id, recipient_count FROM sms_dispatch_log
       WHERE clinic_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [clinicId]
    );
    bulkAuditId = audit.rows[0]?.id || null;
    ok(
      'sms_dispatch_log is not written as sent when Twilio is off',
      !bulkAuditId || Number(audit.rows[0]?.recipient_count) === 0
    );
  } finally {
    if (bulkAuditId) await query('DELETE FROM sms_dispatch_log WHERE id = $1', [bulkAuditId]);
  }

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
      typeof dash.body?.data?.no_shows === 'number' &&
      typeof dash.body?.data?.plans_done === 'number' &&
      typeof dash.body?.data?.plans_open === 'number',
    JSON.stringify(dash.body)
  );
  ok(
    'GET /api/dashboard-data mad_per_hour is null or a number',
    dash.body?.data?.mad_per_hour == null || typeof dash.body?.data?.mad_per_hour === 'number',
    `mad_per_hour=${dash.body?.data?.mad_per_hour}`
  );
  ok(
    'GET /api/dashboard-data week_patients has 7 counts',
    Array.isArray(dash.body?.data?.week_patients) && dash.body.data.week_patients.length === 7,
    JSON.stringify(dash.body?.data?.week_patients)
  );
  ok(
    'GET /api/dashboard-data week_patients are numbers',
    (dash.body?.data?.week_patients || []).every((n) => typeof n === 'number' && Number.isFinite(n))
  );
  ok(
    'GET /api/dashboard-data month_weeks has 4 counts',
    Array.isArray(dash.body?.data?.month_weeks) && dash.body.data.month_weeks.length === 4,
    JSON.stringify(dash.body?.data?.month_weeks)
  );
  ok(
    'GET /api/dashboard-data month_weeks are numbers',
    (dash.body?.data?.month_weeks || []).every((n) => typeof n === 'number' && Number.isFinite(n))
  );
  const hourKeys = [
    'hour_08',
    'hour_09',
    'hour_10',
    'hour_11',
    'hour_12',
    'hour_13',
    'hour_14',
    'hour_15',
    'hour_16',
    'hour_17',
    'hour_18',
  ];
  ok(
    'GET /api/dashboard-data exposes hour_08 through hour_18',
    hourKeys.every((key) => typeof dash.body?.data?.[key] === 'number' && Number.isFinite(dash.body.data[key])),
    JSON.stringify(hourKeys.map((key) => [key, dash.body?.data?.[key]]))
  );
  ok(
    'GET /api/dashboard-data reserved_min is a number',
    typeof dash.body?.data?.reserved_min === 'number' && Number.isFinite(dash.body.data.reserved_min),
    `reserved_min=${dash.body?.data?.reserved_min}`
  );
  ok('GET /api/dashboard-data open_min is 660', dash.body?.data?.open_min === 660, `open_min=${dash.body?.data?.open_min}`);
  ok(
    'GET /api/dashboard-data treatment_mix is an array',
    Array.isArray(dash.body?.data?.treatment_mix),
    JSON.stringify(dash.body?.data?.treatment_mix)
  );
  ok(
    'GET /api/dashboard-data returning_phones is a number',
    typeof dash.body?.data?.returning_phones === 'number' && Number.isFinite(dash.body.data.returning_phones)
  );
  ok(
    'GET /api/dashboard-data new_phones is a number',
    typeof dash.body?.data?.new_phones === 'number' && Number.isFinite(dash.body.data.new_phones)
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
  const calEmbedUrl = clinic.body?.clinic?.calEmbedUrl;
  ok(
    'public clinic exposes calEmbedUrl',
    typeof calEmbedUrl === 'string' && calEmbedUrl.startsWith('https://cal.com/'),
    `calEmbedUrl=${calEmbedUrl}`
  );
  ok(
    'public clinic exposes themeTokens object',
    clinic.body?.clinic?.themeTokens != null && typeof clinic.body.clinic.themeTokens === 'object'
  );

  // ── Session hydration ──────────────────────────────────────────────────
  console.log('\n[auth me]');
  const meGet = await invoke(
    handleAuth,
    createReq({ method: 'GET', url: '/api/auth/me', headers: assistantCookie })
  );
  ok('GET /api/auth/me authenticated returns 200', meGet.statusCode === 200, `status=${meGet.statusCode} body=${JSON.stringify(meGet.body)}`);
  ok('GET /api/auth/me ok:true', meGet.body?.ok === true);
  ok('GET /api/auth/me user.role is assistant', meGet.body?.user?.role === 'assistant');
  ok('GET /api/auth/me user.username is present', Boolean(meGet.body?.user?.username));
  ok(
    'GET /api/auth/me user.displayName is present',
    typeof meGet.body?.user?.displayName === 'string' && meGet.body.user.displayName.length > 0
  );
  ok('GET /api/auth/me clinic.slug is temara', meGet.body?.clinic?.slug === CLINIC_SLUG);
  ok('GET /api/auth/me clinic.name is present', Boolean(meGet.body?.clinic?.name));
  ok(
    'GET /api/auth/me clinic.theme_preset is present',
    typeof meGet.body?.clinic?.theme_preset === 'string' && meGet.body.clinic.theme_preset.length > 0
  );
  ok(
    'GET /api/auth/me clinic.theme_tokens is an object',
    meGet.body?.clinic?.theme_tokens != null && typeof meGet.body.clinic.theme_tokens === 'object'
  );

  const meDoctor = await invoke(
    handleAuth,
    createReq({ method: 'GET', url: '/api/auth/me', headers: doctorCookie })
  );
  ok('GET /api/auth/me as doctor returns 200', meDoctor.statusCode === 200);
  ok('GET /api/auth/me doctor clinic id matches session', Boolean(meDoctor.body?.clinic?.id));

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
  const createdStart = '2026-12-20T09:00:00.000Z';
  const rescheduledStart = '2026-12-20T11:30:00.000Z';

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

  // ── Assistant floor ops ────────────────────────────────────────────────
  console.log('\n[floor-ops]');
  const floorIds = [];
  await cleanupFloorOpsBookings();
  const clinicOpen = casablancaHourNow() >= 8 && casablancaHourNow() < 19;
  try {
    const catalog = await invoke(
      handleRoster,
      createReq({ method: 'GET', url: '/api/roster?catalog=1', headers: assistantCookie })
    );
    ok('GET /api/roster?catalog=1 returns 200', catalog.statusCode === 200, `status=${catalog.statusCode}`);
    ok('catalog lists treatments', Array.isArray(catalog.body?.data?.treatments) && catalog.body.data.treatments.length > 0);
    ok('catalog includes buffer_min', Number(catalog.body?.data?.buffer_min) >= 0);

    const visitStart = '2026-11-03T09:00:00.000+01:00';
    const overlapStart = '2026-11-03T09:05:00.000+01:00';
    const dupPhone = '0655510001';

    const visit = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          kind: 'visit',
          patientName: 'Nadia Floor',
          phone: dupPhone,
          treatment: 'Consultation',
          startsAt: visitStart,
        },
      })
    );
    ok('POST /api/roster visit returns 201', visit.statusCode === 201, `status=${visit.statusCode} body=${JSON.stringify(visit.body)}`);
    if (visit.body?.data?.id) floorIds.push(visit.body.data.id);

    const overlap = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          kind: 'visit',
          patientName: 'Omar Floor',
          phone: '0655510002',
          treatment: 'Consultation',
          startsAt: overlapStart,
        },
      })
    );
    ok('POST /api/roster overlap returns 409', overlap.statusCode === 409, `status=${overlap.statusCode} body=${JSON.stringify(overlap.body)}`);
    ok('overlap uses OVERLAP code', overlap.body?.code === 'OVERLAP');

    const dupHint = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          kind: 'visit',
          patientName: 'Nadia Floor',
          phone: dupPhone,
          treatment: 'Détartrage',
          startsAt: '2026-11-03T11:00:00.000+01:00',
        },
      })
    );
    ok('POST /api/roster duplicate hint returns 409', dupHint.statusCode === 409);
    ok('duplicate uses DUPLICATE_HINT', dupHint.body?.code === 'DUPLICATE_HINT');

    const dupConfirm = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          kind: 'visit',
          patientName: 'Nadia Floor',
          phone: dupPhone,
          treatment: 'Détartrage',
          startsAt: '2026-11-03T11:00:00.000+01:00',
          confirmDuplicate: true,
        },
      })
    );
    ok('confirmDuplicate visit returns 201', dupConfirm.statusCode === 201, `status=${dupConfirm.statusCode}`);
    if (dupConfirm.body?.data?.id) floorIds.push(dupConfirm.body.data.id);

    const walkIn = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          kind: 'visit',
          walkIn: true,
          patientName: 'Walkin Floor',
          phone: '0655510003',
          treatment: 'Urgence',
        },
      })
    );
    if (clinicOpen) {
      const booked = walkIn.statusCode === 201;
      const noGap = walkIn.statusCode === 409 && walkIn.body?.code === 'NO_GAP';
      ok(
        'POST /api/roster walk-in returns 201 or NO_GAP',
        booked || noGap,
        `status=${walkIn.statusCode} body=${JSON.stringify(walkIn.body)}`
      );
      if (booked) {
        ok("walk-in status is En salle d'attente", walkIn.body?.data?.status === "En salle d'attente");
        if (walkIn.body?.data?.id) floorIds.push(walkIn.body.data.id);
      } else {
        ok(
          'walk-in NO_GAP copy is French hours-aware',
          /ouverture|fermeture|créneau libre/i.test(String(walkIn.body?.error || ''))
        );
      }
    } else if (casablancaHourNow() >= 19) {
      ok(
        'POST /api/roster walk-in after hours is 409 NO_GAP',
        walkIn.statusCode === 409 && walkIn.body?.code === 'NO_GAP',
        `status=${walkIn.statusCode} body=${JSON.stringify(walkIn.body)}`
      );
    } else {
      ok(
        'POST /api/roster walk-in before open books the first morning gap or 409',
        walkIn.statusCode === 201 || (walkIn.statusCode === 409 && walkIn.body?.code === 'NO_GAP'),
        `status=${walkIn.statusCode} body=${JSON.stringify(walkIn.body)}`
      );
      if (walkIn.statusCode === 201 && walkIn.body?.data?.id) floorIds.push(walkIn.body.data.id);
    }

    const doctorVisit = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster',
        headers: { ...doctorCookie, 'content-type': 'application/json' },
        body: {
          kind: 'visit',
          patientName: 'Docteur Visit',
          phone: '0655510004',
          treatment: 'Consultation',
          startsAt: '2026-11-04T09:00:00.000+01:00',
        },
      })
    );
    ok('POST visit as doctor returns 403', doctorVisit.statusCode === 403);

    const block = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster',
        headers: { ...doctorCookie, 'content-type': 'application/json' },
        body: {
          kind: 'block',
          blockLabel: 'Déjeuner',
          startsAt: '2026-11-04T12:00:00.000+01:00',
          durationMin: 60,
        },
      })
    );
    ok('POST /api/roster block as doctor returns 201', block.statusCode === 201, `status=${block.statusCode} body=${JSON.stringify(block.body)}`);
    ok('block kind is block', block.body?.data?.booking_kind === 'block');
    if (block.body?.data?.id) floorIds.push(block.body.data.id);

    const assistantBlock = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          kind: 'block',
          blockLabel: 'Labo',
          startsAt: '2026-11-04T14:00:00.000+01:00',
        },
      })
    );
    ok('POST block as assistant returns 403', assistantBlock.statusCode === 403);

    const hold = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster',
        headers: { ...doctorCookie, 'content-type': 'application/json' },
        body: {
          kind: 'emergency_hold',
          startsAt: '2026-11-04T16:00:00.000+01:00',
          durationMin: 30,
        },
      })
    );
    ok('POST emergency_hold returns 201', hold.statusCode === 201, `status=${hold.statusCode}`);
    ok('hold kind is emergency_hold', hold.body?.data?.booking_kind === 'emergency_hold');
    const holdId = hold.body?.data?.id;
    if (holdId) floorIds.push(holdId);

    const released = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster?action=release',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          id: holdId,
          patientName: 'Urgence Relachee',
          phone: '0655510005',
          treatment: 'Urgence',
        },
      })
    );
    ok('POST /api/roster?action=release returns 200', released.statusCode === 200, `status=${released.statusCode} body=${JSON.stringify(released.body)}`);
    ok('released hold becomes visit', released.body?.data?.booking_kind === 'visit');

    const recall = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster?action=recall',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          bookingId: visit.body?.data?.id,
          dueOn: '2020-01-01',
        },
      })
    );
    ok('POST /api/roster?action=recall returns 200', recall.statusCode === 200, `status=${recall.statusCode}`);
    const recallId = recall.body?.data?.id;

    const due = await invoke(
      handleRoster,
      createReq({ method: 'GET', url: '/api/roster?recalls=open', headers: assistantCookie })
    );
    ok('GET /api/roster?recalls=open returns 200', due.statusCode === 200);
    ok(
      'open recalls include the due row',
      (due.body?.data || []).some((row) => row.id === recallId),
      JSON.stringify(due.body?.data)
    );

    const fillBlocked = await invoke(
      handleFillGap,
      createReq({
        method: 'POST',
        url: '/api/fill-gap',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          slotDate: '2026-11-04',
          slotTime: '12:00',
          reason: 'Consultation',
          candidateId: null,
        },
      })
    );
    ok('fill-gap without candidate still lists waitlist', fillBlocked.statusCode === 200);

    if (recallId) await query('DELETE FROM recalls WHERE id = $1', [recallId]);
  } finally {
    if (floorIds.length) {
      await query('DELETE FROM bookings WHERE id = ANY($1::uuid[])', [floorIds]);
    }
    await cleanupFloorOpsBookings();
  }

  // ── n8n port: E.164, ranking, NX, templates, crons, Twilio inbound ─────
  console.log('\n[notify-port]');
  ok('toE164MA converts 06 to +212', toE164MA('0612345678') === '+212612345678');
  ok('toE164MA keeps +212', toE164MA('+212612345678') === '+212612345678');
  ok('toE164MA handles 00 prefix', toE164MA('00212612345678') === '+212612345678');
  ok('isValidMaMobileE164 accepts mobile', isValidMaMobileE164('+212612345678') === true);
  ok('isValidMaMobileE164 rejects short', isValidMaMobileE164('+21261') === false);
  ok('waitlistRank Urgent is 0', waitlistRank('Urgent') === 0);
  ok('waitlistRank Faible is 3', waitlistRank('Faible') === 3);
  const ranked = pickWaitlistTopN(
    [
      { id: 'b', priority: 'Faible', created_at: '2026-01-01' },
      { id: 'a', priority: 'Urgent', created_at: '2026-01-02' },
      { id: 'c', priority: 'Haute', created_at: '2026-01-01' },
      { id: 'd', priority: 'Moyenne', created_at: '2026-01-01' },
    ],
    3
  );
  ok(
    'pickWaitlistTopN is Urgent then Haute then Moyenne',
    ranked.map((row) => row.id).join(',') === 'a,c,d'
  );
  ok(
    'inReminderWindow matches T-24h ± 30m',
    inReminderWindow(new Date(Date.now() + 24 * 60 * 60 * 1000))
  );
  ok(
    'inReminderWindow rejects 2h from now',
    inReminderWindow(new Date(Date.now() + 2 * 60 * 60 * 1000)) === false
  );
  ok('daysBetweenCasablanca today is 0', daysBetweenCasablanca(new Date()) === 0);
  ok(
    'confirm SMS copy is Concierge',
    templates.confirmSms('NADIA').includes('est bien confirmée')
  );
  ok(
    'waitlist SMS copy is Concierge top-3',
    templates.waitlistSms('NADIA', 'https://example.test/book/temara').includes("créneau vient de se libérer")
  );

  const lockKey = `test:lock:${Date.now()}`;
  const firstLock = await tryAcquireLock(lockKey, 60);
  const secondLock = await tryAcquireLock(lockKey, 60);
  ok('NX lock acquires first time', firstLock.acquired === true);
  ok('NX lock duplicates second time', secondLock.duplicate === true && secondLock.acquired === false);
  await query('DELETE FROM notification_locks WHERE lock_key = $1', [lockKey]);

  const token = 'twilio-test-token';
  const twilioBody = { MessageSid: 'SM123', MessageStatus: 'delivered' };
  const twilioUrl = 'https://example.test/api/webhooks/twilio';
  const sortedParams = Object.keys(twilioBody)
    .sort()
    .map((key) => `${key}${twilioBody[key]}`)
    .join('');
  const expectedSig = crypto
    .createHmac('sha1', token)
    .update(`${twilioUrl}${sortedParams}`, 'utf8')
    .digest('base64');
  const fakeReq = { headers: { 'x-twilio-signature': expectedSig }, body: twilioBody };
  ok(
    'Twilio signature timing-safe match',
    verifyTwilioSignature(fakeReq, token, twilioUrl) === true
  );
  fakeReq.headers['x-twilio-signature'] = 'not-the-signature-value-at-all';
  ok(
    'Twilio signature rejects mismatch',
    verifyTwilioSignature(fakeReq, token, twilioUrl) === false
  );
  ok('timingSafeEqualStrings same', timingSafeEqualStrings('abc', 'abc') === true);

  const forceSms = await invoke(
    handleBulkSms,
    createReq({
      method: 'POST',
      url: '/api/bulk-sms?action=force-tomorrow',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: { action: 'force-tomorrow' },
    })
  );
  ok(
    'POST /api/bulk-sms force-tomorrow returns 200',
    forceSms.statusCode === 200,
    `status=${forceSms.statusCode} body=${JSON.stringify(forceSms.body)}`
  );
  ok(
    'force-tomorrow does not fake SIDs',
    forceSms.body?.ok === true && forceSms.body?.dispatchedCount === 0
  );

  const cronReminders = await invoke(
    handleRoster,
    createReq({
      method: 'GET',
      url: '/api/roster?action=cron-reminders',
      headers: assistantCookie,
    })
  );
  ok(
    'GET cron-reminders with staff JWT returns 200',
    cronReminders.statusCode === 200,
    `status=${cronReminders.statusCode} body=${JSON.stringify(cronReminders.body)}`
  );
  ok('cron-reminders ok:true', cronReminders.body?.ok === true);

  const cronLeak = await invoke(
    handleRoster,
    createReq({
      method: 'POST',
      url: '/api/roster?action=cron-leak',
      headers: assistantCookie,
    })
  );
  ok('POST cron-leak with staff JWT returns 200', cronLeak.statusCode === 200);
  ok('cron-leak ok:true', cronLeak.body?.ok === true);

  const twilioStatus = await invoke(
    handleTwilio,
    createReq({
      method: 'POST',
      url: '/api/webhooks/twilio',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: { MessageSid: `SM-test-${Date.now()}`, MessageStatus: 'delivered' },
    })
  );
  ok(
    'POST /api/webhooks/twilio SMS status returns 200 when unsigned local',
    twilioStatus.statusCode === 200,
    `status=${twilioStatus.statusCode} body=${JSON.stringify(twilioStatus.body)}`
  );

  const voiceMenu = await invoke(
    handleTwilio,
    createReq({
      method: 'POST',
      url: '/api/webhooks/twilio',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: {
        Digits: '1',
        From: '+212612345678',
        CallSid: `CA-test-${Date.now()}`,
      },
    })
  );
  ok(
    'POST /api/webhooks/twilio digit 1 returns TwiML',
    voiceMenu.statusCode === 200 && String(voiceMenu.body || '').includes('lien de réservation'),
    `status=${voiceMenu.statusCode} body=${String(voiceMenu.body || '').slice(0, 180)}`
  );

  const voiceGather = await invoke(
    handleTwilio,
    createReq({
      method: 'POST',
      url: '/api/webhooks/twilio',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: {
        From: '+212612345678',
        CallSid: `CA-gather-${Date.now()}`,
      },
    })
  );
  const gatherXml = String(voiceGather.body || '');
  ok(
    'POST /api/webhooks/twilio inbound call returns Gather',
    voiceGather.statusCode === 200 && gatherXml.includes('<Gather') && gatherXml.includes('appuyez sur 1'),
    `status=${voiceGather.statusCode} body=${gatherXml.slice(0, 220)}`
  );
  ok('sanitizeString strips HTML tags', sanitizeString('<b>Nadia</b> & co', 80) === 'Nadia & co');
  ok('sanitizeString keeps French letters', sanitizeString('Béatrice L\'Hôpital', 80) === "Béatrice L'Hôpital");

  const fillNotify = await invoke(
    handleFillGap,
    createReq({
      method: 'POST',
      url: '/api/fill-gap',
      headers: { ...assistantCookie, 'content-type': 'application/json' },
      body: {
        slotDate: '2026-12-01',
        slotTime: '10:00',
        notifyWaitlist: true,
      },
    })
  );
  ok(
    'POST /api/fill-gap notifyWaitlist does not 500',
    fillNotify.statusCode === 200,
    `status=${fillNotify.statusCode}`
  );

  const repeatCreatedBody = {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      uid: `cal-dup-${Date.now()}`,
      startTime: '2026-12-02T09:00:00.000Z',
      title: 'Consultation',
      attendees: [{ name: 'Dup Patient', email: 'dup@example.com', phoneNumber: '0612345678' }],
      responses: { name: { value: 'Dup Patient' }, phone: { value: '0612345678' } },
    },
  };
  const handleCalRepeat = require(path.join(DASHBOARD, 'api/webhooks/cal.js'));
  const firstDup = await invoke(
    handleCalRepeat,
    createReq({
      method: 'POST',
      url: '/api/webhooks/cal',
      headers: calWebhookHeaders(repeatCreatedBody),
      body: repeatCreatedBody,
    })
  );
  const secondDup = await invoke(
    handleCalRepeat,
    createReq({
      method: 'POST',
      url: '/api/webhooks/cal',
      headers: calWebhookHeaders(repeatCreatedBody),
      body: repeatCreatedBody,
    })
  );
  ok('duplicate CREATED still 200', firstDup.statusCode === 200 && secondDup.statusCode === 200);
  ok('duplicate CREATED sets duplicate flag', secondDup.body?.duplicate === true);
  const calPatient = await query(
    `SELECT patient_id FROM bookings WHERE cal_booking_uid = $1`,
    [repeatCreatedBody.payload.uid]
  );
  ok('Cal ingest attaches patient_id', Boolean(calPatient.rows[0]?.patient_id));
  await query('DELETE FROM bookings WHERE cal_booking_uid = $1', [repeatCreatedBody.payload.uid]);

  // ── ROI loops: channel, inbound, no-show NX, crons, patients, levers ──
  console.log('\n[roi-loops]');
  ok(
    'formatWhatsappAddress prefixes once',
    formatWhatsappAddress('+212612345678') === 'whatsapp:+212612345678'
  );
  ok(
    'formatWhatsappAddress strips existing prefix',
    formatWhatsappAddress('whatsapp:+212612345678') === 'whatsapp:+212612345678'
  );
  ok('stripWhatsappPrefix restores E.164', stripWhatsappPrefix('whatsapp:+212612345678') === '+212612345678');
  ok('copay is null without insurance_type', expectedCopayMad('Consultation', null) === null);
  ok('copay is null when insurance is empty', expectedCopayMad('Consultation', '') === null);
  ok('copay CNSS remainder is display-only', expectedCopayMad('Consultation', 'cnss') === 45);
  ok(
    'reminder copy asks to reply 1 / oui / ok',
    templates.reminderSms('NADIA', 'https://example.test/book/temara').includes('Répondez 1')
  );
  ok(
    'inUnconfirmedWindow matches T-2h ±15m',
    inUnconfirmedWindow(new Date(Date.now() + 2 * 60 * 60 * 1000)) === true
  );
  ok(
    'inUnconfirmedWindow rejects T-24h',
    inUnconfirmedWindow(new Date(Date.now() + 24 * 60 * 60 * 1000)) === false
  );

  const prevFetch = global.fetch;
  const prevSid = process.env.TWILIO_ACCOUNT_SID;
  const prevTok = process.env.TWILIO_AUTH_TOKEN;
  const prevFrom = process.env.TWILIO_FROM;
  const prevWa = process.env.TWILIO_WA_FROM;
  try {
    process.env.TWILIO_ACCOUNT_SID = 'ACtestxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.TWILIO_FROM = '+15551234567';
    delete process.env.TWILIO_WA_FROM;
    let captured = null;
    global.fetch = async (_url, opts) => {
      captured = String(opts?.body || '');
      return { ok: true, status: 201, json: async () => ({ sid: 'SMFAKE123', status: 'queued' }) };
    };
    captured = null;
    const smsSend = await sendTwilioMessage({
      to: '+212612345678',
      body: 'sms-path',
      channel: 'sms',
    });
    ok('sendTwilioMessage SMS path returns a SID when fetch succeeds', smsSend.ok === true && smsSend.sid === 'SMFAKE123');
    ok(
      'sendTwilioMessage SMS path does not prefix whatsapp:',
      captured != null && !/whatsapp/i.test(captured)
    );

    captured = 'should-not-post';
    const missingWa = await sendTwilioMessage({
      to: '+212612345678',
      body: 'wa-missing',
      channel: 'whatsapp',
    });
    ok(
      'missing WA from skips with whatsapp_from_missing',
      missingWa.skipped === true && missingWa.reason === 'whatsapp_from_missing'
    );
    ok('missing WA from does not invent a SID', missingWa.sid == null);
    ok('missing WA from does not POST to Twilio', captured === 'should-not-post');

    process.env.TWILIO_WA_FROM = '+15559876543';
    captured = null;
    const waSend = await sendTwilioMessage({
      to: '+212612345678',
      body: 'wa-body',
      channel: 'whatsapp',
    });
    ok('sendTwilioMessage WhatsApp path returns SID', waSend.ok === true && waSend.sid === 'SMFAKE123');
    ok(
      'sendTwilioMessage WhatsApp prefixes whatsapp: on To/From',
      captured != null && /whatsapp%3A%2B212612345678/.test(captured) && /whatsapp%3A%2B15559876543/.test(captured)
    );
  } finally {
    global.fetch = prevFetch;
    if (prevSid == null) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = prevSid;
    if (prevTok == null) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = prevTok;
    if (prevFrom == null) delete process.env.TWILIO_FROM;
    else process.env.TWILIO_FROM = prevFrom;
    if (prevWa == null) delete process.env.TWILIO_WA_FROM;
    else process.env.TWILIO_WA_FROM = prevWa;
  }

  const roiIds = { bookings: [], waitlist: [], recalls: [], patients: [], plans: [], stock: [] };
  const pausedBusy = [];
  try {
    const confirmPhone = '0611987101';
    const confirmE164 = '+212611987101';
    const confirmBooking = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status,
         starts_at, duration_min, booking_kind, updated_at
       )
       VALUES (
         $1, 'Roi Confirm', $2, 'Consultation', 'Confirme',
         NOW() + INTERVAL '26 hours', 20, 'visit', NOW()
       )
       RETURNING id`,
      [clinicId, confirmPhone]
    );
    roiIds.bookings.push(confirmBooking.rows[0].id);

    const inboundConfirm = await invoke(
      handleTwilio,
      createReq({
        method: 'POST',
        url: '/api/webhooks/twilio',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: { Body: '1', From: `whatsapp:${confirmE164}` },
      })
    );
    ok(
      'inbound Body=1 returns confirm action',
      inboundConfirm.statusCode === 200 && inboundConfirm.body?.action === 'confirm',
      `status=${inboundConfirm.statusCode} body=${JSON.stringify(inboundConfirm.body)}`
    );
    const confirmedAt = await query(
      `SELECT patient_confirmed_at, confirmation_state FROM bookings WHERE id = $1`,
      [confirmBooking.rows[0].id]
    );
    ok('inbound Body=1 sets patient_confirmed_at', Boolean(confirmedAt.rows[0]?.patient_confirmed_at));
    ok('inbound Body=1 sets confirmation_state confirmed', confirmedAt.rows[0]?.confirmation_state === 'confirmed');

    const ouiPhone = '0611987111';
    const ouiE164 = '+212611987111';
    const ouiBooking = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status,
         starts_at, duration_min, booking_kind, updated_at
       )
       VALUES (
         $1, 'Roi Oui', $2, 'Consultation', 'Confirme',
         NOW() + INTERVAL '28 hours', 20, 'visit', NOW()
       )
       RETURNING id`,
      [clinicId, ouiPhone]
    );
    roiIds.bookings.push(ouiBooking.rows[0].id);
    const inboundOui = await invoke(
      handleTwilio,
      createReq({
        method: 'POST',
        url: '/api/webhooks/twilio',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: { Body: 'oui', From: ouiE164 },
      })
    );
    ok(
      'inbound Body=oui returns confirm action',
      inboundOui.statusCode === 200 && inboundOui.body?.action === 'confirm',
      `status=${inboundOui.statusCode} body=${JSON.stringify(inboundOui.body)}`
    );
    const ouiConfirmed = await query(
      `SELECT patient_confirmed_at FROM bookings WHERE id = $1`,
      [ouiBooking.rows[0].id]
    );
    ok('inbound Body=oui sets patient_confirmed_at', Boolean(ouiConfirmed.rows[0]?.patient_confirmed_at));

    const stopPhone = '0611987102';
    const stopE164 = '+212611987102';
    const stopPatient = await query(
      `INSERT INTO patients (clinic_id, phone_e164, display_name, sms_consent)
       VALUES ($1, $2, 'Roi Stop', true)
       ON CONFLICT (clinic_id, phone_e164) DO UPDATE SET sms_consent = true, updated_at = NOW()
       RETURNING id`,
      [clinicId, stopE164]
    );
    roiIds.patients.push(stopPatient.rows[0].id);
    const stopWait = await query(
      `INSERT INTO waitlist (clinic_id, patient_name, patient_phone, priority, notes, status, sms_consent)
       VALUES ($1, 'Roi Stop', $2, 'Moyenne', 'roi-stop', 'active', true)
       RETURNING id`,
      [clinicId, stopPhone]
    );
    roiIds.waitlist.push(stopWait.rows[0].id);
    const inboundStop = await invoke(
      handleTwilio,
      createReq({
        method: 'POST',
        url: '/api/webhooks/twilio',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: { Body: 'STOP', From: stopE164 },
      })
    );
    ok(
      'inbound STOP returns stop action',
      inboundStop.statusCode === 200 && inboundStop.body?.action === 'stop',
      `status=${inboundStop.statusCode} body=${JSON.stringify(inboundStop.body)}`
    );
    const stopConsent = await query(`SELECT sms_consent FROM patients WHERE id = $1`, [stopPatient.rows[0].id]);
    const stopWaitConsent = await query(`SELECT sms_consent FROM waitlist WHERE id = $1`, [stopWait.rows[0].id]);
    ok('STOP clears patients.sms_consent', stopConsent.rows[0]?.sms_consent === false);
    ok('STOP clears waitlist.sms_consent', stopWaitConsent.rows[0]?.sms_consent === false);

    const nsWait = await query(
      `INSERT INTO waitlist (clinic_id, patient_name, patient_phone, priority, notes, status, sms_consent)
       VALUES ($1, 'Roi Wait Blast', '0611987103', 'Urgent', 'roi-blast', 'active', true)
       RETURNING id`,
      [clinicId]
    );
    roiIds.waitlist.push(nsWait.rows[0].id);
    const nsBooking = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status,
         starts_at, duration_min, booking_kind, updated_at
       )
       VALUES (
         $1, 'Roi NoShow', '0611987104', 'Consultation', 'Confirme',
         TIMESTAMPTZ '2026-11-03 08:10:00+01', 20, 'visit', NOW()
       )
       RETURNING id`,
      [clinicId]
    );
    roiIds.bookings.push(nsBooking.rows[0].id);
    const noShowOnce = await invoke(
      handleUpdateStatus,
      createReq({
        method: 'POST',
        url: '/api/update-status',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { bookingId: nsBooking.rows[0].id, newStatus: 'no_show' },
      })
    );
    ok(
      'no_show calls blastWaitlistSlot',
      noShowOnce.statusCode === 200 && noShowOnce.body?.waitlistNotify?.ok === true,
      `status=${noShowOnce.statusCode} body=${JSON.stringify(noShowOnce.body?.waitlistNotify)}`
    );
    ok(
      'no_show blast uses staff-noshow batchId',
      String(noShowOnce.body?.waitlistNotify?.batchId || '').startsWith('staff-noshow-')
    );
    const noShowTwice = await invoke(
      handleUpdateStatus,
      createReq({
        method: 'POST',
        url: '/api/update-status',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { bookingId: nsBooking.rows[0].id, newStatus: 'no_show' },
      })
    );
    ok(
      'duplicate no_show does not double-text (NX)',
      noShowTwice.body?.waitlistNotify?.duplicate === true
        || (noShowTwice.body?.waitlistNotify?.skipped || []).some((row) => row.reason === 'already_notified'),
      JSON.stringify(noShowTwice.body?.waitlistNotify)
    );

    const dueRecall = await query(
      `INSERT INTO recalls (clinic_id, patient_name, patient_phone, due_on, treatment_name, status)
       VALUES ($1, 'Roi Recall Due', '0611987108', (NOW() AT TIME ZONE 'Africa/Casablanca')::date, 'Consultation', 'open')
       RETURNING id`,
      [clinicId]
    );
    roiIds.recalls.push(dueRecall.rows[0].id);
    const futureRecall = await query(
      `INSERT INTO recalls (clinic_id, patient_name, patient_phone, due_on, treatment_name, status)
       VALUES ($1, 'Roi Recall Future', '0611987109', (NOW() AT TIME ZONE 'Africa/Casablanca')::date + 40, 'Consultation', 'open')
       RETURNING id`,
      [clinicId]
    );
    roiIds.recalls.push(futureRecall.rows[0].id);
    const cronRecalls = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?action=cron-recalls',
        headers: assistantCookie,
      })
    );
    ok(
      'cron-recalls with staff JWT returns 200',
      cronRecalls.statusCode === 200 && cronRecalls.body?.ok === true,
      `status=${cronRecalls.statusCode} body=${JSON.stringify(cronRecalls.body)}`
    );
    const recallHits = [
      ...(cronRecalls.body?.sent || []),
      ...(cronRecalls.body?.skipped || []),
    ].map((row) => row.id);
    ok('cron-recalls includes open due_on <= today', recallHits.includes(dueRecall.rows[0].id));
    ok('cron-recalls ignores future due_on', !recallHits.includes(futureRecall.rows[0].id));

    const prevCron = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'roi-cron-secret';
    const cronSecretRecalls = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?action=cron-recalls',
        headers: { 'x-cron-secret': 'roi-cron-secret' },
      })
    );
    ok(
      'cron-recalls accepts CRON_SECRET',
      cronSecretRecalls.statusCode === 200 && cronSecretRecalls.body?.ok === true,
      `status=${cronSecretRecalls.statusCode}`
    );
    if (prevCron == null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevCron;

    const unconfirmedTimes = await query(
      `SELECT NOW() + INTERVAL '2 hours' AS in_window, NOW() + INTERVAL '5 hours' AS outside_window`
    );
    const inWindowAt = unconfirmedTimes.rows[0].in_window;
    const outsideWindowAt = unconfirmedTimes.rows[0].outside_window;
    pausedBusy.push(...(await pauseOverlappingBookings(clinicId, inWindowAt)));
    pausedBusy.push(...(await pauseOverlappingBookings(clinicId, outsideWindowAt)));
    const unconfirmedIn = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status,
         starts_at, duration_min, booking_kind, updated_at
       )
       VALUES (
         $1, 'Roi Unconfirmed', '0611987105', 'Consultation', 'Confirme',
         $2, 20, 'visit', NOW()
       )
       RETURNING id`,
      [clinicId, inWindowAt]
    );
    roiIds.bookings.push(unconfirmedIn.rows[0].id);
    const unconfirmedOut = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status,
         starts_at, duration_min, booking_kind, updated_at
       )
       VALUES (
         $1, 'Roi Outside Window', '0611987106', 'Consultation', 'Confirme',
         $2, 20, 'visit', NOW()
       )
       RETURNING id`,
      [clinicId, outsideWindowAt]
    );
    roiIds.bookings.push(unconfirmedOut.rows[0].id);
    const cronUnconfirmed = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?action=cron-unconfirmed',
        headers: assistantCookie,
      })
    );
    ok(
      'cron-unconfirmed returns 200',
      cronUnconfirmed.statusCode === 200 && cronUnconfirmed.body?.ok === true,
      `status=${cronUnconfirmed.statusCode} body=${JSON.stringify(cronUnconfirmed.body)}`
    );
    const markedIds = (cronUnconfirmed.body?.marked || []).map((row) => row.id);
    const skippedOutside = (cronUnconfirmed.body?.skipped || []).some(
      (row) => row.id === unconfirmedOut.rows[0].id && row.reason === 'outside_window'
    );
    ok('cron-unconfirmed marks T-2h visit', markedIds.includes(unconfirmedIn.rows[0].id));
    ok('cron-unconfirmed skips outside T-2h±15m', skippedOutside || !markedIds.includes(unconfirmedOut.rows[0].id));

    const patientDup = await query(
      `SELECT clinic_id, phone_e164, COUNT(*)::int AS n
       FROM patients
       GROUP BY 1, 2
       HAVING COUNT(*) > 1`
    );
    ok('patient backfill is one row per clinic+phone', patientDup.rows.length === 0);

    const patientGetMissing = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?action=patient&id=00000000-0000-4000-8000-000000000099',
        headers: doctorCookie,
      })
    );
    ok(
      'cross-clinic / unknown patient id returns 404',
      patientGetMissing.statusCode === 404,
      `status=${patientGetMissing.statusCode}`
    );

    const planPatient = await query(
      `INSERT INTO patients (clinic_id, phone_e164, display_name, insurance_type)
       VALUES ($1, '+212611987199', 'Roi Plan', 'cnss')
       ON CONFLICT (clinic_id, phone_e164) DO UPDATE
         SET insurance_type = 'cnss', display_name = 'Roi Plan', updated_at = NOW()
       RETURNING id`,
      [clinicId]
    );
    roiIds.patients.push(planPatient.rows[0].id);
    const patientGet = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: `/api/roster?action=patient&id=${planPatient.rows[0].id}`,
        headers: doctorCookie,
      })
    );
    ok('GET patient returns 200', patientGet.statusCode === 200 && patientGet.body?.ok === true);
    ok('GET patient stays clinic-scoped', patientGet.body?.data?.id === planPatient.rows[0].id);

    const directoryGet = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?directory=1',
        headers: doctorCookie,
      })
    );
    ok(
      'GET /api/roster?directory=1 returns 200',
      directoryGet.statusCode === 200 && directoryGet.body?.ok === true,
      `status=${directoryGet.statusCode}`
    );
    ok('directory payload is an array', Array.isArray(directoryGet.body?.data));

    const settingsGet = await invoke(
      handleRoster,
      createReq({
        method: 'GET',
        url: '/api/roster?action=clinic-settings',
        headers: doctorCookie,
      })
    );
    ok(
      'GET clinic-settings returns 200',
      settingsGet.statusCode === 200 && settingsGet.body?.ok === true,
      `status=${settingsGet.statusCode} body=${JSON.stringify(settingsGet.body)}`
    );

    const settingsPatch = await invoke(
      handleRoster,
      createReq({
        method: 'PATCH',
        url: '/api/roster?action=clinic-settings',
        headers: { ...doctorCookie, 'content-type': 'application/json' },
        body: { day_start: '08:30', day_end: '20:00', sms_reminders_enabled: false },
      })
    );
    ok(
      'PATCH clinic-settings returns 200',
      settingsPatch.statusCode === 200 && settingsPatch.body?.ok === true,
      `status=${settingsPatch.statusCode} body=${JSON.stringify(settingsPatch.body)}`
    );
    ok('PATCH clinic-settings persists day_end', settingsPatch.body?.data?.day_end === '20:00');
    ok(
      'PATCH clinic-settings persists SMS pause',
      settingsPatch.body?.data?.sms_reminders_enabled === false
    );

    const settingsRestore = await invoke(
      handleRoster,
      createReq({
        method: 'PATCH',
        url: '/api/roster?action=clinic-settings',
        headers: { ...doctorCookie, 'content-type': 'application/json' },
        body: { day_start: '08:00', day_end: '19:00', sms_reminders_enabled: true },
      })
    );
    ok('clinic-settings restore returns 200', settingsRestore.statusCode === 200);

    const patientPatch = await invoke(
      handleRoster,
      createReq({
        method: 'PATCH',
        url: '/api/roster?action=patient',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: {
          id: planPatient.rows[0].id,
          name: 'Roi Plan',
          allergies: 'Pénicilline',
          notes: 'Note clinique carnet',
          smsConsent: false,
        },
      })
    );
    ok(
      'PATCH patient clinical fields returns 200',
      patientPatch.statusCode === 200 && patientPatch.body?.ok === true,
      `status=${patientPatch.statusCode} body=${JSON.stringify(patientPatch.body)}`
    );
    ok('PATCH patient persists allergies', patientPatch.body?.data?.allergies === 'Pénicilline');
    ok('PATCH patient persists notes', patientPatch.body?.data?.clinical_notes === 'Note clinique carnet');

    const beforeDash = await invoke(
      handleDashboard,
      createReq({ method: 'GET', url: '/api/dashboard-data', headers: doctorCookie })
    );
    const acceptedBefore = Number(beforeDash.body?.data?.accepted_plans) || 0;
    const plansDoneBefore = Number(beforeDash.body?.data?.plans_done) || 0;
    const planCreate = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster?action=plan',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { patientId: planPatient.rows[0].id, title: 'Couronne Roi', steps: [{ label: 'Empreinte' }] },
      })
    );
    ok(
      'POST plan returns 201',
      planCreate.statusCode === 201 && Boolean(planCreate.body?.data?.id),
      `status=${planCreate.statusCode}`
    );
    if (planCreate.body?.data?.id) roiIds.plans.push(planCreate.body.data.id);
    const stepId = planCreate.body?.data?.steps?.[0]?.id;
    if (stepId) {
      const stepDone = await invoke(
        handleRoster,
        createReq({
          method: 'POST',
          url: '/api/roster?action=plan-step',
          headers: { ...assistantCookie, 'content-type': 'application/json' },
          body: { stepId, done: true },
        })
      );
      ok('POST plan-step marks done', stepDone.statusCode === 200 && Boolean(stepDone.body?.data?.done_at));
    }
    const afterDash = await invoke(
      handleDashboard,
      createReq({ method: 'GET', url: '/api/dashboard-data', headers: doctorCookie })
    );
    ok(
      'plan completion is independent of accepted_plans',
      Number(afterDash.body?.data?.accepted_plans) === acceptedBefore,
      `before=${acceptedBefore} after=${afterDash.body?.data?.accepted_plans}`
    );
    ok(
      'plans_done increments from treatment_plans',
      Number(afterDash.body?.data?.plans_done) >= plansDoneBefore + (stepId ? 1 : 0)
    );

    const chargeCount = await query(
      `SELECT COUNT(*) FILTER (WHERE charge_mad IS NOT NULL)::int AS n
       FROM bookings
       WHERE clinic_id = $1
         AND COALESCE(booking_kind, 'visit') = 'visit'
         AND (starts_at AT TIME ZONE 'Africa/Casablanca')::date
           = (NOW() AT TIME ZONE 'Africa/Casablanca')::date
         AND status::text NOT IN ('Annule', 'Annulé')`,
      [clinicId]
    );
    if (Number(chargeCount.rows[0]?.n) === 0) {
      ok('mad_per_hour stays null when no charge_mad', beforeDash.body?.data?.mad_per_hour == null);
    }
    const chargedAt = await query(
      `SELECT ((NOW() AT TIME ZONE 'Africa/Casablanca')::date + TIME '05:17')
         AT TIME ZONE 'Africa/Casablanca' AS starts_at`
    );
    pausedBusy.push(...(await pauseOverlappingBookings(clinicId, chargedAt.rows[0].starts_at)));
    const charged = await query(
      `INSERT INTO bookings (
         clinic_id, patient_name, patient_phone, treatment_name, status,
         starts_at, duration_min, booking_kind, charge_mad, updated_at
       )
       VALUES (
         $1, 'Roi Charge', '0611987107', 'Consultation', 'Termine',
         $2, 20, 'visit', 200, NOW()
       )
       RETURNING id`,
      [clinicId, chargedAt.rows[0].starts_at]
    );
    roiIds.bookings.push(charged.rows[0].id);
    const chargedDash = await invoke(
      handleDashboard,
      createReq({ method: 'GET', url: '/api/dashboard-data', headers: doctorCookie })
    );
    ok(
      'mad_per_hour is computed when charge_mad exists',
      typeof chargedDash.body?.data?.mad_per_hour === 'number' && chargedDash.body.data.mad_per_hour > 0,
      `mad_per_hour=${chargedDash.body?.data?.mad_per_hour}`
    );

    const staffRow = await query(
      `SELECT id FROM staff_users WHERE clinic_id = $1 ORDER BY role::text DESC LIMIT 1`,
      [clinicId]
    );
    const staffId = staffRow.rows[0]?.id;
    if (staffId) {
      await query(`UPDATE bookings SET staff_id = $2 WHERE id = $1`, [charged.rows[0].id, staffId]);
      const filtered = await invoke(
        handleRoster,
        createReq({
          method: 'GET',
          url: `/api/roster?staff_id=${staffId}`,
          headers: assistantCookie,
        })
      );
      ok('GET roster staff_id filter returns 200', filtered.statusCode === 200);
      ok(
        'GET roster staff_id filter only that doctor',
        (filtered.body?.data || []).every((row) => !row.staff_id || row.staff_id === staffId)
      );
    }

    const stockUpsert = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster?action=stock',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { name: 'Gants nitrile', qty: 10, reorderAt: 5 },
      })
    );
    ok('POST stock upserts item', stockUpsert.statusCode === 200 && Boolean(stockUpsert.body?.data?.id));
    if (stockUpsert.body?.data?.id) roiIds.stock.push(stockUpsert.body.data.id);
    const stockUse = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster?action=stock-use',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { itemId: stockUpsert.body?.data?.id, qty: 1, bookingId: charged.rows[0].id },
      })
    );
    ok('POST stock-use decrements qty', stockUse.statusCode === 200 && (stockUse.body?.data?.applied || []).length >= 1);

    const members = await invoke(
      handleRoster,
      createReq({ method: 'GET', url: '/api/roster?action=memberships', headers: doctorCookie })
    );
    ok(
      'GET memberships lists staff_clinic_memberships',
      members.statusCode === 200 && Array.isArray(members.body?.data) && members.body.data.length >= 1
    );

    const referral = await invoke(
      handleRoster,
      createReq({
        method: 'POST',
        url: '/api/roster?action=referral',
        headers: { ...assistantCookie, 'content-type': 'application/json' },
        body: { patientId: planPatient.rows[0].id, toPhone: '0611987110', note: 'Endo' },
      })
    );
    ok(
      'POST referral is text-only and does not fake a SID',
      referral.statusCode === 200 && referral.body?.ok === true && referral.body?.data?.sid == null,
      JSON.stringify(referral.body)
    );

    const tokenRow = await query(
      `UPDATE bookings SET confirm_token = $2 WHERE id = $1 RETURNING confirm_token`,
      [confirmBooking.rows[0].id, `roi${Date.now()}`]
    );
    const publicConfirm = await invoke(
      handlePublicClinic,
      createReq({
        method: 'GET',
        url: `/api/public/clinic/temara?confirm=${tokenRow.rows[0].confirm_token}`,
      })
    );
    ok(
      'public confirm link does not leak clinic id',
      publicConfirm.statusCode === 200
        && publicConfirm.body?.confirm?.confirmed === true
        && !JSON.stringify(publicConfirm.body).includes(clinicId)
    );
    const publicConfirmPost = await invoke(
      handlePublicClinic,
      createReq({
        method: 'POST',
        url: '/api/public/clinic/temara',
        headers: { 'content-type': 'application/json' },
        body: { confirm: tokenRow.rows[0].confirm_token, action: 'confirm' },
      })
    );
    ok('POST public confirm returns 200', publicConfirmPost.statusCode === 200 && publicConfirmPost.body?.ok === true);

    const bulkPatients = await invoke(
      handleBulkSms,
      createReq({
        method: 'POST',
        url: '/api/bulk-sms',
        headers: { ...doctorCookie, 'content-type': 'application/json' },
        body: { action: 'patients', customMessage: 'Message cabinet test roi' },
      })
    );
    ok(
      'POST bulk-sms action=patients does not fake SIDs',
      bulkPatients.statusCode === 200
        && bulkPatients.body?.ok === true
        && Number(bulkPatients.body?.dispatchedCount || 0) === 0
    );
  } finally {
    if (roiIds.plans.length) {
      await query('DELETE FROM plan_steps WHERE plan_id = ANY($1::uuid[])', [roiIds.plans]);
      await query('DELETE FROM treatment_plans WHERE id = ANY($1::uuid[])', [roiIds.plans]);
    }
    if (roiIds.stock.length) {
      await query('DELETE FROM stock_uses WHERE item_id = ANY($1::uuid[])', [roiIds.stock]);
      await query('DELETE FROM stock_items WHERE id = ANY($1::uuid[])', [roiIds.stock]);
    }
    if (roiIds.bookings.length) {
      await query('DELETE FROM stock_uses WHERE booking_id = ANY($1::uuid[])', [roiIds.bookings]);
      await query('DELETE FROM bookings WHERE id = ANY($1::uuid[])', [roiIds.bookings]);
    }
    if (roiIds.waitlist.length) await query('DELETE FROM waitlist WHERE id = ANY($1::uuid[])', [roiIds.waitlist]);
    if (roiIds.recalls.length) await query('DELETE FROM recalls WHERE id = ANY($1::uuid[])', [roiIds.recalls]);
    if (roiIds.patients.length) await query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [roiIds.patients]);
    await restorePausedBookings(pausedBusy);
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
