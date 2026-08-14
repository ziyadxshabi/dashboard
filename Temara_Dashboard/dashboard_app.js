/* --- SECURITY — auth gate handled by auth.js --- */
const AUTH_CONFIG = {
  SESSION_KEY: 'dentaflow_session',
};

function getApiAuthHeaders(extra = {}) {
  const authHeaders = typeof window.DentaFlowAuth?.getAuthHeaders === 'function'
    ? window.DentaFlowAuth.getAuthHeaders()
    : { Accept: 'application/json' };

  return {
    'ngrok-skip-browser-warning': 'true',
    ...authHeaders,
    ...extra,
  };
}

function assertAuthorizedResponse(response) {
  if (typeof window.DentaFlowAuth?.assertAuthorizedResponse === 'function') {
    return window.DentaFlowAuth.assertAuthorizedResponse(response);
  }
  if (response?.status === 401) {
    void window.DentaFlowAuth?.logout?.();
    const err = new Error('Session expirée — reconnectez-vous.');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
  return response;
}

function isUnauthorizedError(error) {
  if (typeof window.DentaFlowAuth?.isUnauthorizedError === 'function') {
    return window.DentaFlowAuth.isUnauthorizedError(error);
  }
  return Boolean(
    error &&
    (error.code === 'UNAUTHORIZED' ||
      /session expir[eé]e|unauthorized|401/i.test(String(error?.message || '')))
  );
}

function unlockDashboard({ skipDashboardFetch = false } = {}) {
  if (
    typeof window.DentaFlowAuth?.isAuthenticated === 'function' &&
    !window.DentaFlowAuth.isAuthenticated()
  ) {
    void window.DentaFlowAuth.logout?.();
    return;
  }

  const overlay = document.getElementById('login-overlay');
  if (overlay) {
    overlay.classList.add('is-unlocking');
    setTimeout(() => overlay.remove(), 400);
  }

  if (!skipDashboardFetch && typeof loadDashboard === 'function') {
    loadDashboard();
  }
  if (typeof loadDoctorHubData === 'function') {
    loadDoctorHubData();
  }
  if (typeof loadTeamNotes === 'function') {
    loadTeamNotes();
  }
}

window.unlockDashboard = unlockDashboard;

document.addEventListener('DOMContentLoaded', () => {
  initAppMode();

  if (document.body.classList.contains('mode-client')) {
    initMotionStack();
    initClientBooking();
  }
});
/* --- END SECURITY --- */

/**
 * Daily Pulse Dashboard — app.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE OVERVIEW
 *
 * This file has exactly one responsibility: fetch data from Google Sheets
 * via an n8n webhook and paint the four KPI cards + two charts.
 *
 * DATA FLOW:
 *   Google Sheets (published CSV via n8n) 
 *     → fetchPatientData()
 *       → computeKPIs()
 *         → renderKPICards()
 *         → renderCharts()
 *
 * WHERE TO INJECT IN SOFTR:
 *   • This entire <script src="app.js"> + <link rel="stylesheet" href="style.css">
 *     goes into Softr → Settings → Custom Code → Footer Code.
 *   • The HTML block (topbar + kpi-row + charts-row) goes into a Softr
 *     "Custom Code" block on your Home page. Place it as the first block.
 *   • The .topbar CSS position:sticky assumes Softr's own navbar is hidden
 *     for logged-in dentist view (use Softr → Pages → visibility rules).
 *
 * SOFTR FREE-TIER BYPASS STRATEGY:
 *   Softr's free "Big Number" blocks only accept static text; they cannot
 *   run JavaScript or react to data. We bypass this entirely by using a
 *   Softr "Custom Code" block (available on all tiers) and injecting our
 *   own DOM. The CSS variables override Softr's default palette via higher
 *   specificity — no !important abuse needed because we own the container.
 *
 * GOOGLE SHEETS BACKEND SETUP (see GOOGLE_SHEETS_SETUP section below):
 *   Your Sheet has 14 columns. We need a second "Calculations" tab.
 */

'use strict';

/* ── CONFIG ─────────────────────────────────────────────────────────────────
 * Update these values in your deployment.
 *
 * DATA_URL: Vercel serverless proxy endpoint. Secrets live server-side in
 *           N8N_WEBHOOK_URL and N8N_AUTH_KEY (see api/n8n-proxy.js).
 *
 * DAILY_GOAL_MAD: Daily revenue target in Moroccan Dirham.
 *
 * REFRESH_INTERVAL_MS: Auto-refresh every N milliseconds. 300000 = 5 minutes.
 */
const DEFAULT_THEME = 'oak-lounge';
const STORAGE_KEYS = {
  THEME: 'doctor_theme',
  DAILY_GOAL: 'doctor_daily_goal',
};

function loadPersistedDailyGoal() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.DAILY_GOAL);
    if (stored == null) return null;
    const val = parseInt(stored, 10);
    if (!Number.isFinite(val) || val < 1000) return null;
    return val;
  } catch {
    return null;
  }
}

function persistDailyGoal(value) {
  try {
    localStorage.setItem(STORAGE_KEYS.DAILY_GOAL, String(value));
  } catch { /* private browsing / disabled storage */ }
}

function resolveInitialTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    if (stored === 'dark') return 'oak-lounge';
    if (stored === 'light') return 'pearl-clinic';
  } catch { /* private browsing / disabled storage */ }
  return DEFAULT_THEME;
}

function persistThemePreference(theme) {
  const storageValue = theme === 'pearl-clinic' ? 'light' : 'dark';
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, storageValue);
  } catch { /* private browsing / disabled storage */ }
}

const CONFIG = {
  API_BASE:             'https://glade-rigor-perennial.ngrok-free.dev',
  DATA_URL:             '/api/dashboard-data',
  ROSTER_PROXY:         '/api/roster',
  UPDATE_STATUS_PROXY:  '/api/update-status',
  TEAM_NOTES_PROXY:     '/api/team-notes',
  BULK_SMS_PROXY:       '/api/bulk-sms',
  DAILY_GOAL_MAD:       15000,
  REFRESH_INTERVAL_MS:  300_000,
  SMART_SYNC_INTERVAL_MS: 180_000,
  SMART_SYNC_DEBOUNCE_MS: 15_000,
  TEAM_NOTES_REFRESH_MS: 60_000,
  ROSTER_ENDPOINT:      '/webhook/assistant-data',
  DIGEST_DAILY_GOAL_MAD: 6000,
  DIGEST_REVENUE_PER_PATIENT_MAD: 400,
  CURRENCY_LOCALE:      'fr-MA',
  CURRENCY:             'MAD',
};

const bootDailyGoal = loadPersistedDailyGoal();
if (bootDailyGoal != null) {
  CONFIG.DAILY_GOAL_MAD = bootDailyGoal;
}

const SUBMIT_LOCK_MS       = 5000;

function lockSubmitButton(btn, processingLabel = 'Traitement...') {
  const defaultLabel = btn.textContent;
  const startedAt = Date.now();
  btn.disabled = true;
  btn.textContent = processingLabel;
  return {
    defaultLabel,
    startedAt,
    minRemaining() {
      return Math.max(0, SUBMIT_LOCK_MS - (Date.now() - startedAt));
    },
  };
}

/* ── GOOGLE SHEETS SETUP GUIDE ─────────────────────────────────────────────
 *
 * SHEET 1 — "Feuille 1" (already exists, populated by n8n Concierge Engine):
 *   Columns A–N:
 *   A: Patient (Nom Complet)     H: Statut Facturation
 *   B: Email Contact             I: Montant (MAD)
 *   C: Téléphone (WhatsApp)      J: Couverture Médicale
 *   D: Date & Heure du RDV       K: N° d'Assurance
 *   E: Motif de Consultation     L: Cal Booking ID
 *   F: Observations Médicales    M: Nouveau Patient ?
 *   G: Statut du RDV             N: Médecin Traitant
 *
 * SHEET 2 — "Calculs" (CREATE THIS TAB):
 *   This is your pre-computed KPI layer. Softr reads from here.
 *   Cell A1: "Metric"              Cell B1: "Valeur"
 *
 *   A2: patients_today
 *   B2: =COUNTIFS('Feuille 1'!D:D,">="&TODAY(),'Feuille 1'!D:D,"<"&(TODAY()+1))
 *
 *   A3: no_shows
 *   B3: =COUNTIFS('Feuille 1'!G:G,"Annulé",'Feuille 1'!D:D,">="&TODAY(),'Feuille 1'!D:D,"<"&(TODAY()+1))
 *        +COUNTIFS('Feuille 1'!G:G,"No-Show",'Feuille 1'!D:D,">="&TODAY(),'Feuille 1'!D:D,"<"&(TODAY()+1))
 *
 *   A4: revenue_today
 *   B4: =SUMIFS('Feuille 1'!I:I,'Feuille 1'!D:D,">="&TODAY(),'Feuille 1'!D:D,"<"&(TODAY()+1))
 *
 *   A5: new_patients
 *   B5: =COUNTIFS('Feuille 1'!M:M,"Oui",'Feuille 1'!D:D,">="&TODAY(),'Feuille 1'!D:D,"<"&(TODAY()+1))
 *
 *   A6: accepted_plans
 *   B6: =COUNTIF('Feuille 1'!G:G,"Confirmé")
 *
 *   A7: pending_plans
 *   B7: =COUNTIF('Feuille 1'!G:G,"En attente")
 *
 *   A8-A16 (hour distribution): one row per hour 8–18
 *   A8:  hour_08
 *   B8:  =COUNTIFS('Feuille 1'!D:D,">="&(TODAY()+TIME(8,0,0)),'Feuille 1'!D:D,"<"&(TODAY()+TIME(9,0,0)))
 *   ... (repeat for 09, 10, 11, 12, 13, 14, 15, 16, 17, 18)
 *
 * N8N WEBHOOK FLOW — "Dashboard Data Endpoint":
 *   Trigger: Webhook (GET /webhook/dashboard-data)
 *   Node 1:  Google Sheets → "Get Many Rows" from "Calculs" sheet, all rows
 *   Node 2:  Code node — transform to { metric: value } object
 *   Node 3:  Respond to Webhook — return JSON body
 *
 *   Code node (Node 2) example:
 *     const rows = $input.all();
 *     const result = {};
 *     for (const r of rows) {
 *       result[r.json['Metric']] = r.json['Valeur'];
 *     }
 *     return [{ json: result }];
 */

/* ── CHART INSTANCES (module-level so we can destroy on refresh) ─────────── */
let hoursChart      = null;
let acceptanceChart = null;
let recoveryOpChart = null;
let flowOpChart     = null;
let lastChartData   = null;
let lastKpiPayload  = null;
let osBootSequencePlayed = false;
let pendingDigestKinetics = null;
let digestKineticsStarted = false;

/* --- ENTRY POINT ---------------------------------------------------- */
let doctorDashboardInitialized = false;

function initializeDoctorDashboard() {
  if (doctorDashboardInitialized) return;
  if (document.body.classList.contains('mode-client')) return;
  if (document.body.classList.contains('mode-assistant')) return;
  if (
    typeof window.DentaFlowAuth?.enforceRouteGuard === 'function' &&
    !window.DentaFlowAuth.enforceRouteGuard()
  ) {
    return;
  }
  if (
    typeof window.DentaFlowAuth?.isAuthenticated === 'function' &&
    !window.DentaFlowAuth.isAuthenticated()
  ) {
    void window.DentaFlowAuth.logout?.();
    return;
  }

  doctorDashboardInitialized = true;
  initMotionStack();
  initHeroGreeting();
  initNavigation();
  initChartToggles();
  initWaitlistForm();
  initUserProfile();
  initSettings();
  initSecurityManagement();
  initThemeSwitcher();
  initAccountCardMenu();
  window.initSettingsDemoState?.();
  initCrmSearch();
  initCrmSidePanel();
  initSmsCampaign();
  initDoctorHub();
  initDoctorCustomSms();
  initOperationalCharts();
  renderDoctorHubCharts();
  bindKpiMicroCharts({});
  renderAppointmentsList();
  renderWaitlistPanel();
  initTeamNotesSync();
  initSmartSync();
  window.initProgressiveDisclosure?.();
  window.initInvisibleUI?.();

  document.querySelectorAll('.dashboard-view').forEach(view => {
    view.setAttribute('aria-hidden', view.classList.contains('active') ? 'false' : 'true');
    if (view.classList.contains('active')) {
      view.classList.add('view-enter-ready');
    }
  });

  if (activeView === 'calendar') {
    initDashboardCalendar();
  }

  if (typeof window.refreshLucideIcons === 'function') {
    window.refreshLucideIcons(document.getElementById('doctor-shell') || document);
  }
}

window.initializeDoctorDashboard = initializeDoctorDashboard;
window.bootDoctorDashboard = initializeDoctorDashboard;

/* ── APPOINTMENT LIST DATA ───────────────────────────────────────────────── */
function getDemoAppointments() {
  return [
    { time: '08:30', name: 'Fatima Zahra',   phone: '+212 661 234 567', treatment: 'Consultation', tagClass: 'consultation', priority: 1 },
    { time: '09:15', name: 'Youssef Benali', phone: '+212 612 987 654', treatment: 'Urgence',      tagClass: 'urgence',      priority: 1 },
    { time: '10:30', name: 'Amina El Fassi', phone: '+212 678 445 120', treatment: 'Blanchiment',  tagClass: 'blanchiment',  priority: 2 },
    { time: '11:45', name: 'Karim Alami',    phone: '+212 655 332 891', treatment: 'Consultation', tagClass: 'consultation', priority: 3 },
    { time: '14:00', name: 'Salma Berrada',  phone: '+212 600 112 233', treatment: 'Consultation', tagClass: 'consultation', priority: 2 },
  ];
}

function buildStatusPill(label, modifierClass = '') {
  const safeLabel = escapeHtml(label || '—');
  const classes = ['status-pill', modifierClass].filter(Boolean).join(' ');
  return `<span class="${classes}"><span class="status-pill__dot" aria-hidden="true"></span>${safeLabel}</span>`;
}

function apptTagModifier(tagClass) {
  if (tagClass === 'urgence') return 'appt-tag--urgence';
  if (tagClass === 'blanchiment') return 'appt-tag--blanchiment';
  return 'appt-tag--consultation';
}

function extractPatientInitials(fullName) {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  return parts
    .slice(0, 2)
    .map((part) => part.replace(/\./g, '')[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2) || '??';
}

function getMatteChipModifier(label) {
  const n = (label ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (n.includes('urgence')) return 'urgence';
  if (n.includes('confirm')) return 'confirmé';
  if (n.includes('annul') || n.includes('no-show')) return 'annulé';
  if (n.includes('attente') || n.includes('soin')) return 'attente';
  if (n.includes('termin')) return 'confirmé';
  return 'attente';
}

function createMatteChip(label) {
  const chip = document.createElement('span');
  chip.className = `matte-chip matte-chip--${getMatteChipModifier(label)}`;
  chip.textContent = label || '—';
  return chip;
}

function createStatusDot(label) {
  const dot = document.createElement('span');
  dot.className = `status-dot status-dot--${getMatteChipModifier(label)}`;
  dot.title = label;
  dot.setAttribute('aria-label', label);
  return dot;
}

function createStatusIndicator(label) {
  const wrap = document.createElement('span');
  wrap.className = 'status-indicator';
  wrap.appendChild(createStatusDot(label));
  const text = document.createElement('span');
  text.className = 'status-indicator__label kinetic-label';
  text.textContent = label;
  wrap.appendChild(text);
  return wrap;
}

function createPatientAvatar(name) {
  const avatar = document.createElement('span');
  avatar.className = 'patient-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = extractPatientInitials(name);
  return avatar;
}

function createPatientIdentity(name) {
  const wrap = document.createElement('div');
  wrap.className = 'patient-identity';
  wrap.appendChild(createPatientAvatar(name));
  const nameEl = document.createElement('span');
  nameEl.className = 'patient-identity__name';
  nameEl.textContent = name || '';
  wrap.appendChild(nameEl);
  return wrap;
}

function getWaitlistPriorityLabel(appt) {
  if (appt.statusLabel) return appt.statusLabel;
  const treatment = String(appt.treatment ?? appt.priorite ?? '').toLowerCase();
  if (appt.tagClass === 'urgence' || treatment === 'haute') return 'Urgence';
  return 'En attente';
}

function createWaitlistTableRow(appt) {
  if (window.DentaFlowRowUI?.createWaitlistTableRow) {
    return window.DentaFlowRowUI.createWaitlistTableRow(appt);
  }

  const tr = document.createElement('tr');
  tr.className = 'waitlist-row';
  tr.dataset.rowInteractive = 'true';
  const patientTd = document.createElement('td');
  patientTd.textContent = appt.name || '';
  const phoneTd = document.createElement('td');
  phoneTd.className = 'col-numeric';
  phoneTd.textContent = appt.phone || '—';
  const priorityTd = document.createElement('td');
  priorityTd.textContent = appt.treatment || '';
  tr.append(patientTd, phoneTd, priorityTd);
  return tr;
}

function createApptCardElement(appt) {
  const card = document.createElement('div');
  card.className = 'appt-card';

  const timeEl = document.createElement('span');
  timeEl.className = 'appt-time';
  timeEl.textContent = appt.time || '';

  const info = document.createElement('div');
  info.className = 'appt-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'appt-name';
  nameEl.textContent = appt.name || '';
  if (appt.name) nameEl.title = appt.name;
  info.appendChild(nameEl);

  const phoneEl = document.createElement('span');
  phoneEl.className = 'appt-phone col-numeric';
  phoneEl.textContent = appt.phone || '—';
  if (appt.phone) phoneEl.title = appt.phone;

  const statusWrap = document.createElement('div');
  statusWrap.className = 'appt-card__status';
  statusWrap.innerHTML = buildStatusPill(appt.treatment, apptTagModifier(appt.tagClass));

  card.append(timeEl, info, phoneEl, statusWrap);
  return card;
}

function buildApptCardHTML(appt) {
  const mod = apptTagModifier(appt.tagClass);
  return `
    <div class="appt-card">
      <span class="appt-time">${escapeHtml(appt.time)}</span>
      <div class="appt-info">
        <div class="appt-name">${escapeHtml(appt.name)}</div>
        ${buildStatusPill(appt.treatment, mod)}
      </div>
    </div>
  `;
}

/* ── FULLCALENDAR — DASHBOARD MANAGEMENT CALENDAR ───────────────────────── */
let dashboardCalendar = null;

function getMondayOfCurrentWeek() {
  const now = new Date();
  const monday = new Date(now);
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function buildWeekEvent(dayOffset, hour, minute, durationMin, title) {
  const start = new Date(getMondayOfCurrentWeek());
  start.setDate(start.getDate() + dayOffset);
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + durationMin);
  return { title, start, end };
}

function getDashboardDemoEvents() {
  return [
    buildWeekEvent(1, 9, 0,  45, 'Consultation — Youssef Benali'),
    buildWeekEvent(2, 10, 30, 60, 'Blanchiment — Amina El Fassi'),
    buildWeekEvent(3, 14, 0,  45, 'Consultation — Fatima Zahra'),
    buildWeekEvent(4, 11, 15, 30, 'Urgence — Karim Alami'),
  ];
}

function initDashboardCalendar() {
  const el = document.getElementById('dashboard-cal-inline');
  if (!el) return;

  if (dashboardCalendar) {
    requestAnimationFrame(() => dashboardCalendar.updateSize());
    return;
  }

  if (typeof FullCalendar === 'undefined') {
    console.error('[Calendar] FullCalendar library not loaded');
    return;
  }

  el.innerHTML = '';

  dashboardCalendar = new FullCalendar.Calendar(el, {
    initialView: 'timeGridWeek',
    headerToolbar: {
      left:   'prev,next today',
      center: 'title',
      right:  'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
    },
    locale: 'fr',
    firstDay: 1,
    height: 'auto',
    expandRows: true,
    slotMinTime: '08:00:00',
    slotMaxTime: '19:00:00',
    nowIndicator: true,
    allDaySlot: false,
    events: getDashboardDemoEvents(),
    eventTimeFormat: {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
  });

  dashboardCalendar.render();
}

/* ── HERO GREETING & DATE ────────────────────────────────────────────────── */
function initHeroGreeting() {
  const greetingEl = document.getElementById('greeting-time');
  const dateEl     = document.getElementById('hero-date');
  if (!greetingEl || !dateEl) return;

  const now = new Date();
  const hour = parseInt(
    now.toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Casablanca' }),
    10
  );

  greetingEl.textContent = hour >= 18 ? 'Bonsoir' : 'Bonjour';

  dateEl.textContent = now.toLocaleDateString('fr-MA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Africa/Casablanca',
  });
}

/* ── SPA ROUTING ─────────────────────────────────────────────────────────── */
const VIEW_MAP = {
  overview:   'view-overview',
  'doctor-hub': 'view-doctor-hub',
  calendar:   'view-calendar',
  waitlist:   'view-waitlist',
  crm:        'view-crm',
  analytics:  'view-analytics',
  sms:        'view-sms',
  settings:   'view-settings',
};

const DEFAULT_VIEW_HASH = '#overview';

let activeView = 'overview';

function viewKeyFromHash(hash = window.location.hash) {
  if (!hash) return null;
  const key = hash.replace(/^#/, '');
  return VIEW_MAP[key] ? key : null;
}

function switchTab(hashId) {
  const viewKey = viewKeyFromHash(hashId);
  if (!viewKey) return;

  const targetId = VIEW_MAP[viewKey];
  if (!targetId || viewKey === activeView) return;

  const views = document.querySelectorAll('.dashboard-view');
  const target = document.getElementById(targetId);

  views.forEach(view => {
    const isTarget = view.id === targetId;
    view.classList.toggle('active', isTarget);
    view.classList.toggle('view-enter-ready', isTarget);
    view.setAttribute('aria-hidden', isTarget ? 'false' : 'true');
  });

  document.querySelectorAll('.nav-link, .tab-link').forEach(link => {
    link.classList.toggle('is-active', link.dataset.nav === viewKey);
  });

  activeView = viewKey;

  const activeTab = document.querySelector(`.tab-link[data-nav="${viewKey}"]`);
  activeTab?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });

  if (viewKey === 'overview') {
    requestAnimationFrame(() => {
      hoursChart?.resize();
      acceptanceChart?.resize();
    });
  }

  if (viewKey === 'calendar') {
    requestAnimationFrame(() => initDashboardCalendar());
  }

  if (viewKey === 'analytics') {
    requestAnimationFrame(() => {
      recoveryOpChart?.resize();
      flowOpChart?.resize();
    });
  }

  if (viewKey === 'doctor-hub') {
    requestAnimationFrame(() => {
      if (osBootSequencePlayed) animateDoctorHubMetrics();
    });
  }
}

function syncTabFromHash() {
  if (!document.body.classList.contains('mode-doctor')) return;

  const hash = window.location.hash;
  const viewKey = viewKeyFromHash(hash);

  if (viewKey) {
    switchTab(hash);
    return;
  }

  const base = window.location.pathname + window.location.search;
  if (hash !== DEFAULT_VIEW_HASH) {
    history.replaceState(null, '', `${base}${DEFAULT_VIEW_HASH}`);
  }
  switchTab(DEFAULT_VIEW_HASH);
}

function initNavigation() {
  syncTabFromHash();
}

function navigateToView(viewKey) {
  if (!VIEW_MAP[viewKey]) return;

  const targetHash = `#${viewKey}`;
  if (window.location.hash === targetHash) {
    switchTab(targetHash);
    return;
  }

  window.location.hash = targetHash;
}

/* ── CHART PERIOD TOGGLE ─────────────────────────────────────────────────── */
function initChartToggles() {
  const toggle  = document.getElementById('chart-toggle');
  const slider  = document.getElementById('chart-toggle-slider');
  const buttons = toggle?.querySelectorAll('.chart-toggle-btn');
  if (!toggle || !slider || !buttons?.length) return;

  function activate(btn, index) {
    buttons.forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    slider.style.transform = `translateX(${index * 100}%)`;
  }

  buttons.forEach((btn, index) => {
    btn?.addEventListener('click', () => activate(btn, index));
  });
}

/* ── TODAY'S SCHEDULE FEED ───────────────────────────────────────────────── */
function renderAppointmentsList() {
  const container = document.getElementById('appointments-list');
  if (!container) return;
  container.replaceChildren();
  const fragment = document.createDocumentFragment();
  getDemoAppointments().forEach((appt) => fragment.appendChild(createApptCardElement(appt)));
  container.appendChild(fragment);
}

function renderWaitlistPanel() {
  const container = document.getElementById('waitlist-panel-list');
  if (!container) return;
  const waitlist = getDemoAppointments()
    .sort((a, b) => a.priority - b.priority)
    .map((appt) => ({
      ...appt,
      statusLabel: appt.tagClass === 'urgence' ? 'Urgence' : 'En attente',
    }));
  container.replaceChildren();

  const table = container.closest('.waitlist-table');
  const ui = window.DentaFlowRowUI;

  if (!waitlist.length) {
    if (ui?.mountEmptyState) {
      ui.mountEmptyState('waitlist-empty-state', {
        message: ui.EMPTY_STATE_DEFAULT_MESSAGE,
        iconSvg: ui.EMPTY_STATE_SVG_INBOX,
      });
    }
    if (table) table.hidden = true;
    return;
  }

  if (ui?.clearEmptyState) ui.clearEmptyState('waitlist-empty-state');
  if (table) table.hidden = false;

  const fragment = document.createDocumentFragment();
  waitlist.forEach((appt) => fragment.appendChild(createWaitlistTableRow(appt)));
  container.appendChild(fragment);
}

/* ── NO-SHOW RECOVERY — WAITLIST FORM ────────────────────────────────────── */
function initWaitlistForm() {
  const form = document.getElementById('waitlist-form');
  if (!form) return;

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const btn        = document.getElementById('waitlist-submit-btn');
    const nameEl     = document.getElementById('waitlist-name');
    const phoneEl    = document.getElementById('waitlist-phone');
    const priorityEl = document.getElementById('waitlist-priority');
    const consentEl  = document.getElementById('waitlist-sms-consent');

    if (!btn || !nameEl || !phoneEl || !priorityEl) return;

    if (!consentEl?.checked) {
      consentEl?.focus();
      return;
    }

    const payload = {
      nom:       nameEl.value.trim(),
      telephone: phoneEl.value.trim(),
      priorite:  priorityEl.value,
    };

    if (!payload.nom || !payload.telephone) return;

    const lock = lockSubmitButton(btn);

    try {
      await submitWaitlistEntry(payload);

      setTimeout(() => {
        btn.textContent = 'Patient ajouté';
        btn.classList.add('is-success');
        form.reset();
        priorityEl.value = 'Normale';
        prependWaitlistEntry(payload);

        setTimeout(() => {
          btn.textContent = lock.defaultLabel;
          btn.classList.remove('is-success');
          btn.disabled = false;
        }, 2500);
      }, lock.minRemaining());
    } catch (err) {
      console.error('[Waitlist] Submission failed:', err?.message || err);
      setTimeout(() => {
        btn.textContent = 'Erreur — Réessayer';
        btn.classList.add('is-error');
        setTimeout(() => {
          btn.textContent = lock.defaultLabel;
          btn.classList.remove('is-error');
          btn.disabled = false;
        }, 2500);
      }, lock.minRemaining());
    }
  });
}

async function submitWaitlistEntry(data) {
  const response = await fetch('/api/waitlist', {
    method:  'POST',
    credentials: 'include',
    headers: getApiAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      nom:       data.nom,
      telephone: data.telephone,
      priorite:  data.priorite,
    }),
  });

  assertAuthorizedResponse(response);

  if (!response.ok) {
    throw new Error(`Waitlist webhook failed: HTTP ${response.status}`);
  }
}

function prependWaitlistEntry({ nom, telephone, priorite }) {
  const container = document.getElementById('waitlist-panel-list');
  if (!container) return;

  const tagClass = priorite === 'Haute' ? 'urgence' : 'consultation';
  container.prepend(createWaitlistTableRow({
    name: nom,
    phone: telephone || '—',
    treatment: priorite,
    tagClass,
    priorite,
  }));
}

/* ── SETTINGS PANEL ──────────────────────────────────────────────────────── */
/** Volatile preferences — live DOM only, reset on full page reload */
const volatileSettings = {
  theme:           'oak-lounge',
  profileName:     null,
  profileSpecialty:null,
  dailyGoal:       null,
  smsReminders:    true,
  emailReminders:  true,
};

function applyTheme(theme) {
  const resolved = theme === 'pearl-clinic' || theme === 'light' ? 'pearl-clinic' : 'oak-lounge';

  document.documentElement.setAttribute('data-theme', resolved);
  volatileSettings.theme = resolved;
  updateThemeSwitcherUI(resolved);

  if (lastChartData) {
    renderCharts(lastChartData);
  }
  if (lastKpiPayload) {
    initOperationalCharts(lastKpiPayload);
  }
}

function isPearlTheme() {
  return document.documentElement.getAttribute('data-theme') === 'pearl-clinic';
}

function getChartThemeColors() {
  if (isPearlTheme()) {
    return {
      grid:           '#000000',
      ticks:          '#000000',
      axisBorder:     '#000000',
      centreText:     '#0A0A0A',
      centreSub:      '#0A0A0A',
      tooltipBg:      '#FDFCFA',
      tooltipBorder:  '#000000',
      tooltipTitle:   '#0A0A0A',
      tooltipBody:    '#262322',
      doughnutBorder: '#000000',
      emptySegment:   '#EAE6DF',
      pendingSegment: '#D5CFC4',
    };
  }

  return {
    grid:           '#1E2530',
    ticks:          '#7A8899',
    axisBorder:     '#1E2530',
    centreText:     '#E8ECF0',
    centreSub:      '#7A8899',
    tooltipBg:      '#1A2030',
    tooltipBorder:  '#252E3E',
    tooltipTitle:   '#E8ECF0',
    tooltipBody:    '#7A8899',
    doughnutBorder: '#141820',
    emptySegment:   '#1E2530',
    pendingSegment: '#252E3E',
  };
}

function updateThemeSwitcherUI(theme) {
  const oakBtn   = document.getElementById('theme-btn-oak');
  const pearlBtn = document.getElementById('theme-btn-pearl');
  const isPearl    = theme === 'pearl-clinic';

  oakBtn?.classList.toggle('is-active', !isPearl);
  pearlBtn?.classList.toggle('is-active', isPearl);
  oakBtn?.setAttribute('aria-pressed', !isPearl ? 'true' : 'false');
  pearlBtn?.setAttribute('aria-pressed', isPearl ? 'true' : 'false');
}

function initThemeSwitcher() {
  const oakBtn   = document.getElementById('theme-btn-oak');
  const pearlBtn = document.getElementById('theme-btn-pearl');
  if (!oakBtn || !pearlBtn) return;

  applyTheme(resolveInitialTheme());

  oakBtn?.addEventListener('click', () => {
    applyTheme('oak-lounge');
    persistThemePreference('oak-lounge');
  });
  pearlBtn?.addEventListener('click', () => {
    applyTheme('pearl-clinic');
    persistThemePreference('pearl-clinic');
  });
}

const PROFILE_DEFAULTS = {
  profileName:      'Dr. Tazi',
  profileSpecialty: 'Chirurgien-dentiste',
};

function extractInitials(fullName) {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  return parts
    .slice(0, 2)
    .map(part => part.replace(/\./g, '')[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2) || '??';
}

function applyUserProfile(name, specialty) {
  const displayName = (name ?? '').trim() || PROFILE_DEFAULTS.profileName;
  const displayRole = (specialty ?? '').trim() || PROFILE_DEFAULTS.profileSpecialty;
  const initials    = extractInitials(displayName);

  const avatarEl = document.getElementById('profile-avatar');
  const nameEl   = document.getElementById('profile-name');
  const roleEl   = document.getElementById('profile-role');
  const heroEl   = document.getElementById('hero-profile-name');

  if (avatarEl) avatarEl.textContent = initials;
  if (nameEl)   nameEl.textContent   = displayName;
  if (roleEl)   roleEl.textContent   = displayRole;
  if (heroEl)   heroEl.textContent   = displayName;
}

function initUserProfile() {
  const saved = loadSettings();
  const nameEl      = document.getElementById('settings-profile-name');
  const specialtyEl = document.getElementById('settings-profile-specialty');

  const profileName      = saved.profileName      ?? PROFILE_DEFAULTS.profileName;
  const profileSpecialty = saved.profileSpecialty ?? PROFILE_DEFAULTS.profileSpecialty;

  if (nameEl)      nameEl.value      = profileName;
  if (specialtyEl) specialtyEl.value = profileSpecialty;

  applyUserProfile(profileName, profileSpecialty);
}

function initAccountCardMenu() {
  document.getElementById('account-menu-settings')?.addEventListener('click', () => {
    if (VIEW_MAP.settings) navigateToView('settings');
  });
  document.getElementById('account-menu-logout')?.addEventListener('click', (event) => {
    event.preventDefault();
    void window.DentaFlowAuth?.logout?.();
  });
  document.getElementById('mobile-logout-btn')?.addEventListener('click', (event) => {
    event.preventDefault();
    void window.DentaFlowAuth?.logout?.();
  });
}

function initSettings() {
  const persistedGoal = loadPersistedDailyGoal();
  if (persistedGoal != null) {
    CONFIG.DAILY_GOAL_MAD = persistedGoal;
  }

  const saved = loadSettings();
  const goalEl = document.getElementById('settings-daily-goal');
  if (goalEl) {
    if (persistedGoal != null) {
      goalEl.value = persistedGoal;
    } else if (saved.dailyGoal) {
      goalEl.value = saved.dailyGoal;
      CONFIG.DAILY_GOAL_MAD = saved.dailyGoal;
    }
  }

  const smsToggle = document.getElementById('settings-sms-toggle');
  const emailToggle = document.getElementById('settings-email-toggle');
  if (smsToggle && smsToggle.dataset.demoBound !== 'true') {
    smsToggle.checked = saved.smsReminders !== false;
  }
  if (emailToggle && emailToggle.dataset.demoBound !== 'true') {
    emailToggle.checked = saved.emailReminders !== false;
  }
}

function applyDoctorDailyGoal(value) {
  const val = Number(value);
  if (!Number.isFinite(val) || val < 1000) return;
  CONFIG.DAILY_GOAL_MAD = val;
  saveSettings({ dailyGoal: val });
  persistDailyGoal(val);
  setText('val-goal', formatMADShort(CONFIG.DAILY_GOAL_MAD));
  if (lastKpiPayload) bindKpiMicroCharts(lastKpiPayload);
}

window.applyDoctorDailyGoal = applyDoctorDailyGoal;

function loadSettings() {
  return { ...volatileSettings };
}

function saveSettings(partial) {
  Object.assign(volatileSettings, partial);
}

const SECURITY_PWD_KEYS = {
  doc: 'df_pwd_doc',
  asst: 'df_pwd_asst',
};

const SECURITY_ACCOUNT_LABELS = {
  doc: 'Compte Docteur (Admin)',
  asst: 'Compte Assistante (Staff)',
};

const SECURITY_TOAST_NAMES = {
  doc: 'Docteur',
  asst: 'Assistante',
};

let securityToastTimer = null;

function showDashboardToast(message, type = 'info') {
  const toast = document.getElementById('assistant-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('is-error', 'is-success', 'is-warning');
  if (type === 'error') toast.classList.add('is-error');
  if (type === 'success') toast.classList.add('is-success');
  if (type === 'warning') toast.classList.add('is-warning');
  toast.classList.add('is-visible');
  clearTimeout(securityToastTimer);
  securityToastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function initSecurityAccountSelect() {
  const root = document.getElementById('security-account-root');
  const hidden = document.getElementById('security-account-input');
  const trigger = document.getElementById('security-account-trigger');
  const list = document.getElementById('security-account-list');
  const label = document.getElementById('security-account-value');
  if (!root || !hidden || !trigger || !list) return null;

  const options = Array.from(list.querySelectorAll('.ghost-select__option'));

  function setValue(value) {
    const resolved = value === 'asst' ? 'asst' : 'doc';
    hidden.value = resolved;
    if (label) label.textContent = SECURITY_ACCOUNT_LABELS[resolved];
    options.forEach((option) => {
      const selected = option.dataset.value === resolved;
      option.classList.toggle('is-selected', selected);
      option.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  function closeList() {
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    options.forEach((option) => option.classList.remove('is-focused'));
  }

  function openList() {
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (list.hidden) openList();
    else closeList();
  });

  options.forEach((option) => {
    option.addEventListener('click', () => {
      setValue(option.dataset.value || 'doc');
      closeList();
      trigger.focus();
    });
  });

  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) closeList();
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeList();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) openList();
      const currentIndex = options.findIndex((option) => option.classList.contains('is-selected'));
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (currentIndex + delta + options.length) % options.length;
      options.forEach((option) => option.classList.remove('is-focused'));
      options[nextIndex]?.classList.add('is-focused');
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const focused = options.find((option) => option.classList.contains('is-focused'));
      if (focused && !list.hidden) {
        event.preventDefault();
        setValue(focused.dataset.value || 'doc');
        closeList();
      }
    }
  });

  return setValue;
}

function initSecurityManagement() {
  const form = document.getElementById('security-access-form');
  if (!form || form.dataset.securityBound === 'true') return;
  form.dataset.securityBound = 'true';

  initSecurityAccountSelect();

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const accountInput = document.getElementById('security-account-input');
    const passwordNew = document.getElementById('security-password-new');
    const passwordConfirm = document.getElementById('security-password-confirm');
    const submitBtn = document.getElementById('security-submit-btn');

    if (!accountInput || !passwordNew || !passwordConfirm) return;

    const newPassword = passwordNew.value;
    const confirmPassword = passwordConfirm.value;

    if (!newPassword || !confirmPassword) {
      showDashboardToast('Veuillez renseigner les deux champs de mot de passe.', 'warning');
      if (!newPassword) passwordNew.focus();
      else passwordConfirm.focus();
      return;
    }

    if (newPassword !== confirmPassword) {
      showDashboardToast('Les mots de passe ne correspondent pas.', 'error');
      passwordConfirm.focus();
      return;
    }

    const accountKey = accountInput.value === 'asst' ? 'asst' : 'doc';
    const storageKey = SECURITY_PWD_KEYS[accountKey];
    const roleName = SECURITY_TOAST_NAMES[accountKey];

    if (submitBtn) submitBtn.disabled = true;

    try {
      localStorage.setItem(storageKey, newPassword);
      passwordNew.value = '';
      passwordConfirm.value = '';
      showDashboardToast(`Mot de passe ${roleName} mis à jour avec succès.`, 'success');
    } catch (error) {
      console.error('[Security] Password save failed:', error?.message || error);
      showDashboardToast('Impossible d\'enregistrer le mot de passe — réessayez.', 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

/* ── CRM PATIENT SEARCH ──────────────────────────────────────────────────── */
function initCrmSearch() {
  const searchEl = document.getElementById('crm-search');
  const tbody    = document.getElementById('crm-table-body');
  if (!searchEl || !tbody) return;

  searchEl?.addEventListener('input', () => {
    const query = searchEl.value.trim().toLowerCase();
    tbody.querySelectorAll('tr').forEach(row => {
      const text = row.textContent.toLowerCase();
      row.classList.toggle('is-hidden', query.length > 0 && !text.includes(query));
    });
  });
}

/* ── CRM DOSSIER PATIENT — SLIDE-OVER PANEL ─────────────────────────────── */
let crmPatientsById = {};

function getCrmMotifTagClass(motif) {
  const normalised = String(motif ?? '').toLowerCase();
  if (normalised.includes('urgence')) return 'crm-tag--urgence';
  if (normalised.includes('blanch')) return 'crm-tag--gold';
  return '';
}

function toCrmPatient(record) {
  if (!record) return null;
  return {
    id: record.id ?? record.rowId,
    name: record.name || 'Non spécifié',
    phone: record.phone || '',
    email: record.email || '',
    motif: record.treatment || 'Consultation',
    statut: record.status || 'Confirmé',
    observations: record.observations || 'Aucune observation enregistrée.',
    insurance: record.insurance || '—',
    amount: Number(record.amount) || 0,
  };
}

function renderCRMTable(records) {
  const tbody = document.getElementById('crm-table-body');
  if (!tbody) return;

  const rows = Array.isArray(records) ? records.filter(Boolean) : [];
  crmPatientsById = {};
  tbody.replaceChildren();

  if (!rows.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.className = 'crm-table-empty';
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = 'Aucun patient trouvé';
    emptyRow.appendChild(cell);
    tbody.appendChild(emptyRow);
    return;
  }

  rows.forEach((record) => {
    const patient = toCrmPatient(record);
    if (!patient?.id) return;

    crmPatientsById[String(patient.id)] = patient;

    const tr = document.createElement('tr');
    tr.className = 'crm-table-row';
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    tr.dataset.patientId = String(patient.id);
    tr.dataset.name = patient.name;
    tr.dataset.phone = patient.phone;
    tr.dataset.email = patient.email;
    tr.dataset.motif = patient.motif;
    tr.dataset.statut = patient.statut;
    tr.dataset.amount = String(patient.amount);
    tr.dataset.insurance = patient.insurance;
    tr.dataset.observations = patient.observations;

    const nameCell = document.createElement('td');
    nameCell.textContent = patient.name;

    const phoneCell = document.createElement('td');
    phoneCell.textContent = patient.phone || '—';

    const emailCell = document.createElement('td');
    emailCell.textContent = patient.email || '—';

    const motifCell = document.createElement('td');
    const motifTag = document.createElement('span');
    const motifMod = getCrmMotifTagClass(patient.motif);
    motifTag.className = ['crm-tag', motifMod].filter(Boolean).join(' ');
    motifTag.textContent = patient.motif;
    motifCell.appendChild(motifTag);

    tr.append(nameCell, phoneCell, emailCell, motifCell);
    tbody.appendChild(tr);
  });
}

function getCrmStatutTagClass(statut) {
  const normalised = (statut ?? '').toLowerCase();
  if (normalised.includes('confirm')) return 'crm-tag--confirmé';
  if (normalised.includes('attente')) return 'crm-tag--attente';
  if (normalised.includes('annul') || normalised.includes('no-show')) return 'crm-tag--urgence';
  return '';
}

function readCrmRowData(row) {
  const patientId = row?.dataset?.patientId;
  if (patientId && crmPatientsById[patientId]) {
    return crmPatientsById[patientId];
  }

  const { dataset } = row;
  return {
    name:          dataset.name          ?? row.cells[0]?.textContent.trim() ?? '—',
    phone:         dataset.phone         ?? row.cells[1]?.textContent.trim() ?? '',
    email:         dataset.email         ?? row.cells[2]?.textContent.trim() ?? '',
    motif:         dataset.motif         ?? row.cells[3]?.textContent.trim() ?? '—',
    statut:        dataset.statut        ?? '—',
    amount:        parseFloat(dataset.amount) || 0,
    insurance:     dataset.insurance     ?? '—',
    observations:  dataset.observations  ?? 'Aucune observation enregistrée.',
  };
}

function populateCrmSidePanel(patient) {
  setText('crm-panel-name', patient.name);

  const subtitleEl = document.getElementById('crm-panel-subtitle');
  if (subtitleEl) {
    const parts = [patient.phone, patient.email].filter(Boolean);
    subtitleEl.textContent = parts.join(' · ');
  }

  const statutEl = document.getElementById('crm-panel-statut');
  if (statutEl) {
    const label = patient.statut || '—';
    const mod = getCrmStatutTagClass(label);
    statutEl.className = `crm-side-panel-statut status-pill ${mod}`.trim();
    if (window.DentaFlowDom?.setStatusPill) {
      window.DentaFlowDom.setStatusPill(statutEl, label);
    } else {
      statutEl.textContent = label;
    }
  }

  setText('crm-panel-amount', `${formatMAD(patient.amount)} MAD`);
  setText('crm-panel-insurance', patient.insurance);
  setText('crm-panel-motif', patient.motif);
  setText('crm-panel-observations', patient.observations);
}

function openCrmSidePanel(patient, selectedRow) {
  const root = document.getElementById('crm-side-panel');
  if (!root) return;

  populateCrmSidePanel(patient);

  document.querySelectorAll('.crm-table-row.is-selected').forEach(row => {
    row.classList.remove('is-selected');
  });
  selectedRow?.classList.add('is-selected');

  root.classList.add('is-active');
  root.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    document.getElementById('crm-side-panel-close')?.focus();
  });
}

function closeCrmSidePanel() {
  const root = document.getElementById('crm-side-panel');
  if (!root || !root.classList.contains('is-active')) return;

  root.classList.remove('is-active');
  root.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';

  document.querySelectorAll('.crm-table-row.is-selected').forEach(row => {
    row.classList.remove('is-selected');
  });
}

function initCrmSidePanel() {
  const root     = document.getElementById('crm-side-panel');
  const overlay  = document.getElementById('crm-side-panel-overlay');
  const closeBtn = document.getElementById('crm-side-panel-close');
  const tbody    = document.getElementById('crm-table-body');
  if (!root || !tbody) return;

  function handleRowActivate(row) {
    if (row.classList.contains('is-hidden')) return;
    openCrmSidePanel(readCrmRowData(row), row);
  }

  tbody?.addEventListener('click', (e) => {
    const row = e.target.closest('.crm-table-row');
    if (row) handleRowActivate(row);
  });

  tbody?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.crm-table-row');
    if (!row) return;
    e.preventDefault();
    handleRowActivate(row);
  });

  closeBtn?.addEventListener('click', closeCrmSidePanel);
  overlay?.addEventListener('click', closeCrmSidePanel);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('is-active')) {
      closeCrmSidePanel();
    }
  });
}

/* ── SMS CAMPAIGN ────────────────────────────────────────────────────────── */
const SMS_MAX_CHARS = 320;
const DOCTOR_CUSTOM_SMS_MAX = 320;

function initDoctorCustomSms() {
  const textarea = document.getElementById('doctor-custom-sms-text');
  const submitBtn = document.getElementById('btn-doctor-custom-sms');
  const counter = document.getElementById('doctor-custom-sms-count');
  if (!textarea || !submitBtn || submitBtn.dataset.wired === 'true') return;
  submitBtn.dataset.wired = 'true';

  function updateCounter() {
    if (!counter) return;
    const len = textarea.value.length;
    counter.textContent = `${len} / ${DOCTOR_CUSTOM_SMS_MAX}`;
    counter.classList.toggle('is-limit', len >= DOCTOR_CUSTOM_SMS_MAX);
  }

  textarea.addEventListener('input', updateCounter);
  updateCounter();

  submitBtn.addEventListener('click', async () => {
    const customMessage = textarea.value.trim();
    if (!customMessage) {
      showDashboardToast('Saisissez un message avant d\'envoyer.', 'error');
      textarea.focus();
      return;
    }

    const lock = lockSubmitButton(submitBtn, 'Envoi en cours…');
    submitBtn.classList.add('is-loading');

    try {
      const response = await fetch(CONFIG.BULK_SMS_PROXY, {
        method: 'POST',
        credentials: 'include',
        headers: getApiAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ customMessage }),
        signal: AbortSignal.timeout(12_000),
      });

      assertAuthorizedResponse(response);

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || payload?.details || `HTTP ${response.status}`);
      }

      showDashboardToast('Message personnalisé envoyé avec succès.', 'success');
      textarea.value = '';
      updateCounter();
    } catch (err) {
      console.error('[Doctor Custom SMS] Failed:', err?.message || err);
      showDashboardToast('Échec de l\'envoi — réessayez.', 'error');
    } finally {
      submitBtn.classList.remove('is-loading');
      setTimeout(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = lock.defaultLabel;
      }, lock.minRemaining());
    }
  });
}

function initSmsCampaign() {
  const form     = document.getElementById('sms-campaign-form');
  const textarea = document.getElementById('sms-campaign-body');
  const counter  = document.getElementById('sms-char-count');
  const counterWrap = counter?.parentElement;
  const submitBtn = document.getElementById('sms-campaign-submit');
  if (!form || !textarea || !counter) return;

  function updateCounter() {
    const len = textarea.value.length;
    counter.textContent = String(len);
    counterWrap?.classList.toggle('is-warning', len > SMS_MAX_CHARS * 0.85 && len < SMS_MAX_CHARS);
    counterWrap?.classList.toggle('is-limit', len >= SMS_MAX_CHARS);
  }

  textarea?.addEventListener('input', updateCounter);
  updateCounter();

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    console.warn('SMS module not yet wired to backend');
    alert('La fonction de campagne SMS sera disponible dans la prochaine mise à jour.');
  });
}

/* ── SKELETON LOADING STATE ──────────────────────────────────────────────── */
function applySkeletonState() {
  setSyncState('loading', 'Actualisation…');
  ['val-patients','val-noshows','val-new','patients-recovered-count','estimated-revenue-range'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('skeleton');
  });
}

function clearSkeletonState() {
  ['val-patients','val-noshows','val-new','patients-recovered-count','estimated-revenue-range'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('skeleton');
  });
}

/* ── SYNC DOT STATE ──────────────────────────────────────────────────────── */
function setSyncState(state, label) {
  const dot  = document.getElementById('sync-dot');
  const text = document.getElementById('sync-label');
  if (!dot || !text) return;
  dot.className = `sync-dot ${state}`;
  text.textContent = label;
}

/* ── HTTP STATUS → descriptive error messages ───────────────────────────── */
function describeHttpError(status) {
  if (status === 429) {
    return 'Limite de requêtes atteinte (HTTP 429). Réessayez dans quelques minutes.';
  }
  if (status === 500) {
    return 'Erreur interne du serveur (HTTP 500). Données de démonstration affichées.';
  }
  if (status === 502) {
    return 'Passerelle indisponible (HTTP 502). Données de démonstration affichées.';
  }
  if (status === 504) {
    return 'Délai d\'attente dépassé côté serveur (HTTP 504). Données de démonstration affichées.';
  }
  return `Erreur HTTP ${status}. Données de démonstration affichées.`;
}

function describeConnectionError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return 'Connexion expirée (10 s). Données de démonstration affichées.';
  }
  if (err instanceof TypeError) {
    return 'Connexion impossible au serveur. Mode hors-ligne activé.';
  }
  return err?.message ?? 'Erreur de connexion inconnue.';
}

function showOfflineBanner(errorBanner, message) {
  if (!errorBanner) return;
  errorBanner.textContent = message || 'Mode hors-ligne — connexion serveur indisponible.';
  errorBanner.hidden = false;
}

/** Coerce API values to safe numbers — never pass error strings into KPI formatters. */
function asMetric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Zeroed dataset used when the backend is unreachable. */
function getEmptyDashboardData() {
  return {
    patients_today:  0,
    no_shows:        0,
    revenue_today:   0,
    new_patients:    0,
    accepted_plans:  0,
    pending_plans:   0,
    hour_08: 0, hour_09: 0, hour_10: 0, hour_11: 0,
    hour_12: 0, hour_13: 0, hour_14: 0, hour_15: 0,
    hour_16: 0, hour_17: 0, hour_18: 0,
    patients_recovered: 0,
    reclaimed_revenue: 0,
  };
}

/** Pristine empty UI — em-dashes in stat cards, zeroed charts, no error strings in KPIs. */
function renderDashboardFallback() {
  clearSkeletonState();

  const noshowCard = document.getElementById('card-noshows');
  noshowCard?.classList.remove('kpi-card--danger');

  ['patients-recovered-count', 'estimated-revenue-range', 'val-patients', 'val-noshows', 'val-new'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = '—';
      el.classList.remove('skeleton', 'kpi-metric--error');
    }
  });

  updateRecoveryMetrics(0);

  setText('sub-patients', 'En attente de connexion');
  setText('sub-noshows', '—');
  setText('sub-new', '—');

  renderCharts(getEmptyDashboardData());
  refreshOperationalCharts(getEmptyDashboardData());
}

function handleDashboardLoadError(err, errorBanner) {
  console.error('[Dashboard] Load failed:', err?.message || err);

  document.body.classList.add('dashboard-offline');
  setSyncState('error', 'Mode hors-ligne');
  showOfflineBanner(errorBanner, 'Mode hors-ligne — connexion serveur indisponible.');
  renderDashboardFallback();
}

async function parseDashboardJson(response) {
  const text = await response.text();

  if (!text || !text.trim()) {
    throw new Error('Réponse vide du serveur — le workflow n8n n\'a renvoyé aucune donnée.');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Réponse JSON invalide — vérifiez la sortie du webhook n8n.');
  }
}

/* ── MAIN DATA FETCH ─────────────────────────────────────────────────────── */
async function loadDashboard(isSilentSync = false) {
  const errorBanner = document.getElementById('error-banner');

  try {
    window.DentaFlowAuth?.requireSession?.();

    if (!isSilentSync) {
      applySkeletonState();
    }

    const response = await fetch(CONFIG.DATA_URL, {
      method:  'GET',
      credentials: 'include',
      headers: getApiAuthHeaders(),
      cache:   'no-store',
      signal:  AbortSignal.timeout(10_000),
    });

    assertAuthorizedResponse(response);

    if (response.status === 429 || response.status === 504) {
      throw new Error(describeHttpError(response.status));
    }

    if (response.status === 500 || response.status === 502) {
      let msg = describeHttpError(response.status);
      try {
        const errBody = await response.clone().json();
        if (typeof errBody?.details === 'string' && errBody.details.trim()) {
          msg = `Erreur n8n — ${errBody.details.slice(0, 160)}`;
        } else if (typeof errBody?.error === 'string' && errBody.error.trim()) {
          msg = `Erreur n8n — ${errBody.error}`;
        }
      } catch { /* keep generic status message */ }
      throw new Error(msg);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const raw = await parseDashboardJson(response);

    if (raw && raw.ok === false) {
      const detail = typeof raw.details === 'string' ? raw.details.slice(0, 160) : '';

      throw new Error(detail ? `Erreur n8n — ${detail}` : (raw.error || 'Erreur amont'));
    }

    const data = normaliseData(raw);

    clearSkeletonState();
    document.body.classList.remove('dashboard-offline');
    if (errorBanner) errorBanner.hidden = true;

    renderKPICards(data);
    renderCharts(data);

    const now = new Date().toLocaleTimeString('fr-MA', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca',
    });
    setSyncState('ok', `Mis à jour à ${now}`);

  } catch (err) {
    if (isUnauthorizedError(err)) {
      // Logout/redirect already in flight — skip offline/degraded UI.
      return;
    }
    if (isSilentSync) {
      console.warn('[Dashboard] Silent sync failed:', err?.message || err);
      return;
    }
    handleDashboardLoadError(err, errorBanner);
  }
}

/* ── NORMALISE RAW RESPONSE ─────────────────────────────────────────────── */
function normaliseData(raw) {
  // raw may be an array (n8n default output) or an object
  if (Array.isArray(raw) && raw.length > 0) {
    // n8n returns [{ json: {...} }] or just [{ metric: val, ... }]
    raw = raw[0]?.json ?? raw[0];
  }

  // New secure payload format: { ok: true, data: { ...metrics } }
  if (raw && typeof raw === 'object' && raw.ok === true) {
    raw = raw.data ?? raw.metrics ?? {};
  }

  const out = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
      out[k] = Number(v);
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else if (v != null && typeof v !== 'object') {
      out[k] = asMetric(v);
    }
  }
  return out;
}

/* ── DEMO DATA (dev preview only — not used on fetch failure) ───────────── */
function getDemoData() {
  return {
    patients_today:  8,
    no_shows:        2,
    revenue_today:   9400,
    new_patients:    3,
    accepted_plans:  11,
    pending_plans:   4,
    hour_08: 1, hour_09: 2, hour_10: 3, hour_11: 2,
    hour_12: 1, hour_13: 0, hour_14: 2, hour_15: 3,
    hour_16: 2, hour_17: 1, hour_18: 0,
    patients_recovered: 14,
    reclaimed_revenue: 18500,
  };
}

/* ── KPI MICRO-CHARTS (data-driven SVG helpers) ─────────────────────────── */

const PULSE_BAR_COUNT = 4;

function pulseChartRatio(current, target) {
  const value = Number(current);
  const goal = Number(target);
  if (!Number.isFinite(value) || value < 0) return 0;
  if (!Number.isFinite(goal) || goal <= 0) return 0;
  return Math.min(value / goal, 1);
}

function updateDoughnutChart(svgElement, current, target) {
  if (!svgElement) return;
  const circles = svgElement.querySelectorAll('circle');
  const progressCircle = circles[1];
  if (!progressCircle) return;

  const pct = pulseChartRatio(current, target);
  const radius = parseFloat(progressCircle.getAttribute('r') || '10');
  if (!Number.isFinite(radius) || radius <= 0) return;

  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct * circumference);

  progressCircle.setAttribute('stroke-dasharray', circumference.toFixed(2));
  progressCircle.setAttribute('stroke-dashoffset', offset.toFixed(2));
}

function updateBarChart(svgContainer, totalAbsences) {
  if (!svgContainer) return;
  const rects = Array.from(svgContainer.querySelectorAll('rect'));
  if (!rects.length) return;

  const viewBox = svgContainer.viewBox?.baseVal;
  const height = viewBox?.height || 22;
  const minH = 2;
  const maxH = height - 4;
  const total = Math.max(0, Math.floor(Number(totalAbsences) || 0));

  rects.forEach((rect, index) => {
    let barH = minH;
    let scaleY = 0.1;

    if (total > 0) {
      const isTall = index < Math.min(total, rects.length);
      if (isTall) {
        const intensity = Math.min(1, total / Math.max(rects.length, 1));
        barH = Math.max(minH, intensity * maxH * (0.55 + 0.45 * ((index % Math.max(total, 1)) + 1) / Math.max(total, 1)));
        scaleY = 1;
      } else {
        barH = minH;
        scaleY = 0.15;
      }
    }

    const y = height - barH - 2;
    rect.setAttribute('height', barH.toFixed(1));
    rect.setAttribute('y', y.toFixed(1));
    rect.dataset.pulseScaleY = String(scaleY);
  });
}

function setSparklineGeometry(pathElement, d, points) {
  if (!pathElement) return;
  const tag = pathElement.tagName.toLowerCase();
  if (tag === 'path') {
    pathElement.setAttribute('d', d);
    return;
  }
  if (tag === 'polyline' && points) {
    pathElement.setAttribute('points', points);
  }
}

function updateSparkline(pathElement, value, maxValue) {
  if (!pathElement) return;

  const svg = pathElement.ownerSVGElement;
  const viewBox = svg?.viewBox?.baseVal;
  const width = viewBox?.width || 52;
  const height = viewBox?.height || 22;

  const safeValue = Number(value);
  const safeMax = Number(maxValue);
  const hasValue = Number.isFinite(safeValue) && safeValue > 0;
  const max = Number.isFinite(safeMax) && safeMax > 0 ? safeMax : 1;
  const ratio = hasValue ? Math.min(safeValue / max, 1) : 0;

  const flatY = 10;
  const midY = 15;
  const midX = width / 2;
  const qX = width * 0.35;

  if (ratio === 0) {
    const flatD = `M 0 ${flatY} L ${midX.toFixed(1)} ${flatY} L ${width} ${flatY}`;
    const flatPoints = `0,${flatY} ${midX.toFixed(1)},${flatY} ${width},${flatY}`;
    setSparklineGeometry(pathElement, flatD, flatPoints);
    return;
  }

  const peakY = Math.max(2, height - 2 - ratio * (height - 6));
  const dynamicD = `M 0 ${midY} Q ${qX.toFixed(1)} ${peakY.toFixed(1)} ${midX.toFixed(1)} ${midY} T ${width} ${flatY}`;
  setSparklineGeometry(pathElement, dynamicD, `0,${midY} ${qX.toFixed(1)},${peakY.toFixed(1)} ${midX.toFixed(1)},${midY} ${width},${flatY}`);
}

function buildSparklineSvg(_values, { width = 52, height = 22, tone = 'gold' } = {}) {
  return `<svg class="pulse-sparkline pulse-sparkline--${tone}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M 0 10 L ${(width / 2).toFixed(1)} 10 L ${width} 10"/></svg>`;
}

function buildBarChartSvg(_values, { width = 52, height = 22, tone = 'danger', barCount = PULSE_BAR_COUNT } = {}) {
  const count = Math.max(1, barCount);
  const barW = Math.max(4, (width - (count - 1) * 3) / count);
  const minH = 2;
  const bars = Array.from({ length: count }, (_, index) => {
    const x = index * (barW + 3);
    const y = height - minH - 2;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${minH.toFixed(1)}" rx="1" data-pulse-scale-y="0.1"/>`;
  }).join('');
  return `<svg class="pulse-bars pulse-bars--${tone}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${bars}</svg>`;
}

function buildDoughnutSvg(_percent, { size = 28, tone = 'success', radius = 10 } = {}) {
  const circumference = 2 * Math.PI * radius;
  return `<svg class="pulse-doughnut pulse-doughnut--${tone}" viewBox="0 0 28 28" width="${size}" height="${size}" aria-hidden="true"><circle cx="14" cy="14" r="${radius}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2.5"/><circle cx="14" cy="14" r="${radius}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${circumference.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 14 14)"/></svg>`;
}

function animatePulseCharts(scope) {
  if (!scope || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const gsap = window.gsap;
  if (!gsap) return;

  scope.querySelectorAll('.pulse-sparkline path, .pulse-sparkline polyline').forEach((strokeEl, index) => {
    const length = typeof strokeEl.getTotalLength === 'function'
      ? strokeEl.getTotalLength()
      : 120;
    strokeEl.style.strokeDasharray = String(length);
    strokeEl.style.strokeDashoffset = String(length);
    gsap.to(strokeEl, {
      strokeDashoffset: 0,
      duration: 1.2,
      delay: index * 0.12,
      ease: 'power2.out',
    });
  });

  scope.querySelectorAll('.pulse-bars rect').forEach((rect, index) => {
    const targetScaleY = parseFloat(rect.dataset.pulseScaleY || '1');
    gsap.fromTo(
      rect,
      { scaleY: 0, transformOrigin: 'center bottom' },
      {
        scaleY: targetScaleY,
        duration: 0.85,
        delay: 0.15 + index * 0.07,
        ease: 'power2.out',
      }
    );
  });

  scope.querySelectorAll('.pulse-doughnut circle').forEach((circle, circleIndex) => {
    if (circleIndex === 0) return;
    const dashArray = parseFloat(circle.getAttribute('stroke-dasharray') || '0');
    const targetOffset = parseFloat(circle.getAttribute('stroke-dashoffset') || '0');
    if (!dashArray) return;
    circle.style.strokeDasharray = String(dashArray);
    circle.style.strokeDashoffset = String(dashArray);
    gsap.to(circle, {
      strokeDashoffset: targetOffset,
      duration: 1.3,
      delay: 0.2,
      ease: 'power2.out',
    });
  });
}

function bindKpiMicroCharts(data = {}) {
  const patientsToday = asMetric(data.patients_today);
  const noShows = asMetric(data.no_shows);
  const newPatients = asMetric(data.new_patients);

  const trendPatientsSvg = document.querySelector('#trend-patients svg');
  updateSparkline(trendPatientsSvg?.querySelector('path, polyline'), patientsToday, 24);

  const trendNoshowsSvg = document.querySelector('#trend-noshows svg');
  updateBarChart(trendNoshowsSvg, noShows);

  const trendNewSvg = document.querySelector('#trend-new svg');
  updateSparkline(trendNewSvg?.querySelector('path, polyline'), newPatients, 10);

  const kpiScope = document.querySelector('.kpi-row');
  if (kpiScope) animatePulseCharts(kpiScope);
}

window.DentaFlowPulseCharts = {
  updateDoughnutChart,
  updateBarChart,
  updateSparkline,
  animatePulseCharts,
  buildSparklineSvg,
  buildBarChartSvg,
  buildDoughnutSvg,
  bindKpiMicroCharts,
  renderDynamicChart,
  buildSevenDayTrendFromData,
};

function setKpiTrend(id, markup) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = markup;
}

function formatHubProductionMad(value) {
  const n = asMetric(value, 0);
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

const WEEKDAY_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

function getLast7DayLabels() {
  const labels = [];
  const now = new Date();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - offset);
    labels.push(WEEKDAY_SHORT[day.getDay()]);
  }
  return labels;
}

function buildSevenDayTrendFromData(data = {}) {
  const labels = getLast7DayLabels();

  if (Array.isArray(data.week_patients) && data.week_patients.length >= 7) {
    return labels.map((label, index) => ({
      label,
      value: asMetric(data.week_patients[index]),
    }));
  }

  const dayKeys = ['day_6', 'day_5', 'day_4', 'day_3', 'day_2', 'day_1', 'day_0'];
  if (dayKeys.some((key) => data[key] != null)) {
    return labels.map((label, index) => ({
      label,
      value: asMetric(data[dayKeys[index]]),
    }));
  }

  const base = asMetric(data.patients_today, 0);
  const shape = [0.72, 0.85, 0.9, 1, 0.95, 0.65, 0.4];
  return labels.map((label, index) => ({
    label,
    value: index === 6
      ? Math.max(base, 0)
      : Math.max(0, Math.round(base * shape[index])),
  }));
}

function normalizeChartSeries(data) {
  if (Array.isArray(data)) {
    return data.slice(0, 7).map((point, index) => ({
      label: String(point?.label ?? getLast7DayLabels()[index] ?? ''),
      value: asMetric(point?.value),
    }));
  }
  return buildSevenDayTrendFromData(data);
}

function positionOakChartTooltip(tooltip, bar, container) {
  const barRect = bar.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const left = barRect.left - containerRect.left + barRect.width / 2;
  const top = barRect.top - containerRect.top;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function bindOakChartBarInteractions(bar, col, tooltip, container, point, unitLabel) {
  const show = () => {
    tooltip.querySelector('.oak-chart-tooltip__day').textContent = point.label;
    tooltip.querySelector('.oak-chart-tooltip__value').textContent =
      `${point.value} ${unitLabel}`;
    positionOakChartTooltip(tooltip, bar, container);
    tooltip.classList.add('is-visible');
    tooltip.hidden = false;
  };

  const hide = () => {
    tooltip.classList.remove('is-visible');
    tooltip.hidden = true;
  };

  bar.addEventListener('pointerenter', show);
  bar.addEventListener('pointerleave', hide);
  bar.addEventListener('focus', show);
  bar.addEventListener('blur', hide);
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });

  col.addEventListener('touchstart', (event) => {
    event.stopPropagation();
    show();
  }, { passive: true });
}

function animateOakChartBars(container, duration = 640) {
  const bars = container.querySelectorAll('.oak-chart-bar');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  bars.forEach((bar, index) => {
    const target = bar.style.getPropertyValue('--bar-target') || '0%';
    const targetPct = parseFloat(target) || 0;

    if (reducedMotion) {
      bar.style.height = `${targetPct}%`;
      return;
    }

    const delay = index * 45;
    const startAt = performance.now() + delay;

    function frame(now) {
      if (now < startAt) {
        requestAnimationFrame(frame);
        return;
      }
      const elapsed = now - startAt;
      const progress = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      bar.style.height = `${targetPct * eased}%`;
      if (progress < 1) requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  });
}

function renderDynamicChart(data, containerId, options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const series = normalizeChartSeries(data);
  const unitLabel = options.unit === 'revenue' ? 'MAD' : 'patients';
  const maxVal = Math.max(...series.map((point) => point.value), 1);
  const peakIndex = series.reduce(
    (best, point, index, arr) => (point.value >= arr[best].value ? index : best),
    0,
  );

  container.replaceChildren();

  const plot = document.createElement('div');
  plot.className = 'oak-chart-plot';

  const grid = document.createElement('div');
  grid.className = 'oak-chart-grid';
  grid.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i += 1) {
    const line = document.createElement('div');
    line.className = 'oak-chart-grid__line';
    grid.appendChild(line);
  }

  const bars = document.createElement('div');
  bars.className = 'oak-chart-bars';

  const tooltip = document.createElement('div');
  tooltip.className = 'oak-chart-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  tooltip.innerHTML =
    '<span class="oak-chart-tooltip__day"></span><span class="oak-chart-tooltip__value"></span>';

  series.forEach((point, index) => {
    const col = document.createElement('div');
    col.className = 'oak-chart-bar-col';

    const track = document.createElement('div');
    track.className = 'oak-chart-bar-track';

    const bar = document.createElement('div');
    bar.className = 'oak-chart-bar';
    if (index === peakIndex && point.value > 0) {
      bar.classList.add('oak-chart-bar--peak');
    }
    bar.style.setProperty('--bar-target', `${(point.value / maxVal) * 100}%`);
    bar.style.height = '0%';
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('aria-label', `${point.label} : ${point.value} ${unitLabel}`);

    const label = document.createElement('span');
    label.className = 'oak-chart-bar-label';
    label.textContent = point.label;

    track.appendChild(bar);
    col.appendChild(track);
    col.appendChild(label);
    bars.appendChild(col);

    bindOakChartBarInteractions(bar, col, tooltip, container, point, unitLabel);
  });

  plot.appendChild(grid);
  plot.appendChild(bars);
  container.appendChild(plot);
  container.appendChild(tooltip);

  const summary = series.map((point) => `${point.label} ${point.value}`).join(', ');
  container.setAttribute('aria-label', `Tendance 7 jours : ${summary}`);

  if (!container.dataset.touchBound) {
    container.dataset.touchBound = 'true';
    document.addEventListener('touchstart', (event) => {
      if (!container.contains(event.target)) {
        tooltip.classList.remove('is-visible');
        tooltip.hidden = true;
      }
    }, { passive: true });
  }

  animateOakChartBars(container);
}

function renderDoctorHubCharts(data = {}) {
  renderDynamicChart(data, 'doctor-weekly-trend-chart', { unit: 'patients' });
}

function renderKPICards(data) {
  lastKpiPayload = data;
  const patients_today    = asMetric(data?.patients_today);
  const no_shows          = asMetric(data?.no_shows);
  const patients_recovered = asMetric(data?.patients_recovered ?? data?.reclaimed_patients);
  const new_patients      = asMetric(data?.new_patients);

  setKpiTrend('trend-patients', buildSparklineSvg(null, { tone: 'gold' }));
  setKpiTrend('trend-noshows', buildBarChartSvg(null, { tone: 'danger' }));
  setKpiTrend('trend-new', buildSparklineSvg(null, { tone: 'muted' }));

  const pendingQuotes = asMetric(data?.pending_plans ?? data?.pending_quotes);
  const revenueToday = asMetric(data?.revenue_today);

  renderDoctorHubCharts(data);
  bindKpiMicroCharts(data);

  setKPINumber('hub-val-patients', patients_today, true);
  setKPINumber('hub-val-pending', pendingQuotes, true);
  setKPINumber('hub-val-noshows', no_shows, true);
  const hubProductionEl = document.getElementById('hub-val-production');
  if (hubProductionEl) hubProductionEl.textContent = formatHubProductionMad(revenueToday);

  setText('hub-delta-patients', patients_today > 0 ? 'Aujourd\'hui' : 'Aucun RDV');
  setText('hub-delta-pending', pendingQuotes > 0
    ? `${pendingQuotes} devis à valider`
    : 'Devis à valider');
  setText('hub-delta-noshows', no_shows > 0
    ? `${no_shows} créneau${no_shows > 1 ? 'x' : ''} libre${no_shows > 1 ? 's' : ''}`
    : 'Aucune absence');
  setText('hub-delta-production', 'MAD facturés');

  // Recovery hero banner — patients recovered + estimated revenue range
  updateRecoveryMetrics(patients_recovered);
  refreshOperationalCharts(data);

  // Card 1: Patients today
  setKPINumber('val-patients', patients_today, true);
  setText('sub-patients', `Rendez-vous confirmés`);

  // Card 2: No-shows / cancellations — danger state if > 0
  const noshowCard = document.getElementById('card-noshows');
  if (noshowCard) {
    if (no_shows > 0) {
      noshowCard.classList.add('kpi-card--danger');
      // Danger number appears instantly — no animation
      const el = document.getElementById('val-noshows');
      if (el) {
        el.textContent = no_shows;
        el.style.color = ''; // inherits danger card color via CSS
      }
      setText('sub-noshows', no_shows === 1
        ? '1 créneau à combler d\'urgence'
        : `${no_shows} créneaux à combler`
      );
    } else {
      noshowCard.classList.remove('kpi-card--danger');
      setKPINumber('val-noshows', 0, true);
      setText('sub-noshows', 'Aucune annulation');
    }
  }

  // Card 3: New patients
  setKPINumber('val-new', new_patients, true);
  setText('sub-new',
    new_patients === 0
      ? 'Aucun formulaire en attente'
      : `${new_patients} formulaire${new_patients > 1 ? 's' : ''} d'entrée requis`
  );
}

/* ── OPERATIONAL ANALYTICS (Performances view) ──────────────────────────── */

const OPERATIONAL_CHART_GOLD = '#C89E66';
const OPERATIONAL_CHART_TICK = '#888893';
const OPERATIONAL_CHART_GRID = 'rgba(255, 255, 255, 0.03)';
const OPERATIONAL_CHART_MUTED_BAR = 'rgba(255, 255, 255, 0.05)';

function getOperationalChartTooltipOptions() {
  return {
    backgroundColor: 'rgba(20, 20, 25, 0.85)',
    titleColor: '#FFFFFF',
    bodyColor: '#A0A0AB',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    padding: 12,
    cornerRadius: 8,
    displayColors: true,
    boxPadding: 6,
  };
}

function getOperationalChartTickStyle() {
  return {
    color: OPERATIONAL_CHART_TICK,
    font: { family: 'Inter, sans-serif', size: 11 },
  };
}

function applyChartJsDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = OPERATIONAL_CHART_TICK;
  Chart.defaults.font.family = 'Inter, sans-serif';
}

function buildOperationalChartPayload(data = {}) {
  const patientsToday = asMetric(data.patients_today);
  const newPatients = asMetric(data.new_patients);
  const noShows = asMetric(data.no_shows);
  const hasLiveData = patientsToday > 0 || newPatients > 0 || noShows > 0;

  const recovery = {
    labels: ['Semaine 1', 'Semaine 2', 'Semaine 3', 'Semaine 4'],
    cancellations: [12, 8, 15, 9],
    recovered: [10, 7, 14, 8],
  };

  if (hasLiveData) {
    const factor = Math.max(noShows / 12, 0.65);
    recovery.cancellations = recovery.cancellations.map((v) => Math.max(1, Math.round(v * factor)));
    recovery.recovered = recovery.recovered.map((v) => Math.max(1, Math.round(v * factor * 0.92)));
  }

  let flowValues = [65, 25, 10];
  if (hasLiveData) {
    const recurring = Math.max(patientsToday - newPatients, 0);
    const urgences = Math.max(noShows, 0);
    const total = recurring + newPatients + urgences;
    if (total > 0) {
      flowValues = [
        Math.round((recurring / total) * 100),
        Math.round((newPatients / total) * 100),
        Math.round((urgences / total) * 100),
      ];
    }
  }

  return {
    recovery,
    flow: {
      labels: ['Patients Récurrents', 'Nouveaux Patients', 'Urgences'],
      values: flowValues,
    },
  };
}

function createRecoveryAreaGradient(canvas) {
  const ctx = canvas.getContext('2d');
  const height = canvas.parentElement?.clientHeight || 300;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(200, 158, 102, 0.2)');
  gradient.addColorStop(1, 'rgba(200, 158, 102, 0)');
  return gradient;
}

function getFlowBarColors() {
  return [OPERATIONAL_CHART_MUTED_BAR, OPERATIONAL_CHART_MUTED_BAR, OPERATIONAL_CHART_GOLD];
}

function initOperationalCharts(data = {}) {
  if (typeof Chart === 'undefined') return;

  applyChartJsDefaults();
  const payload = buildOperationalChartPayload(data);

  const recoveryCtx = document.getElementById('recoveryChart');
  if (recoveryCtx) {
    if (recoveryOpChart) {
      recoveryOpChart.destroy();
      recoveryOpChart = null;
    }

    const recoveryGradient = createRecoveryAreaGradient(recoveryCtx);

    recoveryOpChart = new Chart(recoveryCtx, {
      type: 'bar',
      data: {
        labels: payload.recovery.labels,
        datasets: [
          {
            type: 'bar',
            label: 'Annulations',
            data: payload.recovery.cancellations,
            backgroundColor: OPERATIONAL_CHART_MUTED_BAR,
            borderWidth: 0,
            borderRadius: 6,
            order: 2,
          },
          {
            type: 'line',
            label: 'Créneaux Récupérés',
            data: payload.recovery.recovered,
            borderColor: OPERATIONAL_CHART_GOLD,
            backgroundColor: recoveryGradient,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: OPERATIONAL_CHART_GOLD,
            pointHoverBorderColor: '#1A1A1F',
            pointHoverBorderWidth: 2,
            tension: 0.4,
            fill: true,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            align: 'end',
            labels: {
              boxWidth: 10,
              boxHeight: 10,
              usePointStyle: true,
              color: OPERATIONAL_CHART_TICK,
              font: { family: 'Inter, sans-serif', size: 11 },
            },
          },
          tooltip: getOperationalChartTooltipOptions(),
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: getOperationalChartTickStyle(),
          },
          y: {
            beginAtZero: true,
            grid: {
              display: true,
              color: OPERATIONAL_CHART_GRID,
              drawTicks: false,
            },
            border: { display: false },
            ticks: {
              ...getOperationalChartTickStyle(),
              precision: 0,
            },
          },
        },
      },
    });
  }

  const flowCtx = document.getElementById('flowChart');
  if (flowCtx) {
    if (flowOpChart) {
      flowOpChart.destroy();
      flowOpChart = null;
    }

    flowOpChart = new Chart(flowCtx, {
      type: 'bar',
      data: {
        labels: payload.flow.labels,
        datasets: [{
          data: payload.flow.values,
          backgroundColor: getFlowBarColors(),
          borderWidth: 0,
          borderRadius: 6,
          borderSkipped: false,
          barThickness: 14,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...getOperationalChartTooltipOptions(),
            callbacks: {
              label: (ctx) => ` ${ctx.label}: ${ctx.parsed.x}%`,
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            max: 100,
            grid: {
              display: true,
              color: OPERATIONAL_CHART_GRID,
              drawTicks: false,
            },
            border: { display: false },
            ticks: {
              ...getOperationalChartTickStyle(),
              callback: (value) => `${value}%`,
            },
          },
          y: {
            grid: { display: false },
            border: { display: false },
            ticks: getOperationalChartTickStyle(),
          },
        },
      },
    });
  }
}

function refreshOperationalCharts(data = {}) {
  if (!recoveryOpChart && !flowOpChart) {
    initOperationalCharts(data);
    return;
  }

  const payload = buildOperationalChartPayload(data);

  if (recoveryOpChart) {
    recoveryOpChart.data.labels = payload.recovery.labels;
    recoveryOpChart.data.datasets[0].data = payload.recovery.cancellations;
    recoveryOpChart.data.datasets[1].data = payload.recovery.recovered;
    recoveryOpChart.update('none');
  }

  if (flowOpChart) {
    flowOpChart.data.labels = payload.flow.labels;
    flowOpChart.data.datasets[0].data = payload.flow.values;
    flowOpChart.data.datasets[0].backgroundColor = getFlowBarColors();
    flowOpChart.update('none');
  }
}

/* ── CHARTS ─────────────────────────────────────────────────────────────── */
function renderCharts(data) {
  lastChartData = data;
  renderHoursChart(data);
  renderAcceptanceChart(data);
}

/* Bar chart: patient volume by hour */
function renderHoursChart(data) {
  const hours  = ['08h','09h','10h','11h','12h','13h','14h','15h','16h','17h','18h'];
  const keys   = ['hour_08','hour_09','hour_10','hour_11','hour_12',
                  'hour_13','hour_14','hour_15','hour_16','hour_17','hour_18'];
  const values = keys.map(k => asMetric(data?.[k]));
  const maxVal = Math.max(...values, 1);

  // Colour bars: accent for busy hours, dimmer for quiet
  const colors = values.map(v => {
    const intensity = v / maxVal;
    return intensity >= 0.75
      ? 'rgba(232, 201, 122, 0.90)'  // peak
      : intensity >= 0.4
      ? 'rgba(184, 150, 90, 0.65)'   // moderate
      : 'rgba(184, 150, 90, 0.25)';  // quiet
  });

  const ctx = document.getElementById('chart-hours');
  if (!ctx) return;

  if (hoursChart) { hoursChart.destroy(); hoursChart = null; }

  const chartTheme = getChartThemeColors();

  hoursChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: hours,
      datasets: [{
        label: 'Patients',
        data:  values,
        backgroundColor: colors,
        borderColor:     colors.map(c => c.replace(/[\d.]+\)$/, '1)')),
        borderWidth: 0,
        borderRadius: 10,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 700,
        easing: 'easeOutQuart',
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: chartTheme.tooltipBg,
          borderColor:     chartTheme.tooltipBorder,
          borderWidth:     1,
          titleColor:      chartTheme.tooltipTitle,
          bodyColor:       chartTheme.tooltipBody,
          callbacks: {
            label: ctx => ` ${ctx.parsed.y} patient${ctx.parsed.y !== 1 ? 's' : ''}`,
          }
        },
      },
      scales: {
        x: {
          grid:  { color: chartTheme.grid, drawBorder: false },
          ticks: { color: chartTheme.ticks, font: { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', size: 11 } },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color:     chartTheme.ticks,
            font:      { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', size: 11 },
            stepSize:  1,
            precision: 0,
          },
          grid: { color: chartTheme.grid, drawBorder: false },
        },
      },
    }
  });
}

/* Donut chart: treatment acceptance */
function renderAcceptanceChart(data) {
  const accepted = asMetric(data?.accepted_plans);
  const pending  = asMetric(data?.pending_plans);
  const total    = accepted + pending;

  const ctx = document.getElementById('chart-acceptance');
  if (!ctx) return;

  if (acceptanceChart) { acceptanceChart.destroy(); acceptanceChart = null; }

  const chartTheme = getChartThemeColors();
  const isEmpty = total === 0;
  const chartData = isEmpty ? [1] : [accepted, pending];
  const chartColors = isEmpty
    ? [chartTheme.emptySegment]
    : ['#b8965a', chartTheme.pendingSegment];
  const chartLabels = isEmpty
    ? ['Aucune donnée']
    : ['Accepté', 'En attente'];

  acceptanceChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: chartLabels,
      datasets: [{
        data:            chartData,
        backgroundColor: chartColors,
        borderColor:     chartTheme.doughnutBorder,
        borderWidth:     3,
        hoverOffset:     isEmpty ? 0 : 6,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '70%',
      animation: { duration: 700, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: !isEmpty,
          backgroundColor: chartTheme.tooltipBg,
          borderColor:     chartTheme.tooltipBorder,
          borderWidth:     1,
          titleColor:      chartTheme.tooltipTitle,
          bodyColor:       chartTheme.tooltipBody,
          callbacks: {
            label: ctx => {
              const pct = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0;
              return ` ${ctx.label} : ${ctx.parsed} (${pct}%)`;
            }
          }
        },
      },
    },
    plugins: [{
      // Centre text showing acceptance rate %
      id: 'centreText',
      beforeDraw(chart) {
        const { width, height, ctx } = chart;
        ctx.save();
        const pct = total > 0 ? Math.round((accepted / total) * 100) : 0;
        const displayText = isEmpty ? '—' : `${pct}%`;
        const subText = isEmpty ? 'données' : 'acceptés';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        const centerX = width / 2;
        const centerY = height / 2;
        ctx.font = `900 ${Math.min(width, height) * 0.18}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.fillStyle = chartTheme.centreText;
        ctx.fillText(displayText, centerX, centerY - 8);
        ctx.font = `500 ${Math.min(width, height) * 0.085}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.fillStyle = chartTheme.centreSub;
        ctx.fillText(subText, centerX, centerY + 18);
        ctx.restore();
      }
    }]
  });

  // Render custom legend
  const legendEl = document.getElementById('pie-legend');
  if (legendEl && !isEmpty) {
    const items = [
      { label: 'Accepté',    value: accepted, color: '#b8965a' },
      { label: 'En attente', value: pending,  color: chartTheme.pendingSegment },
    ];
    legendEl.replaceChildren();
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'pie-legend-item';
      const dot = document.createElement('span');
      dot.className = 'pie-legend-dot';
      dot.style.backgroundColor = item.color;
      const labelSpan = document.createElement('span');
      labelSpan.textContent = item.label;
      const valueSpan = document.createElement('span');
      valueSpan.className = 'pie-legend-value';
      valueSpan.textContent = String(item.value);
      row.append(dot, labelSpan, valueSpan);
      legendEl.appendChild(row);
    });
  }
}

/* ── HELPERS ─────────────────────────────────────────────────────────────── */

/**
 * Animate a number from 0 to target with easeOut.
 * Skipped entirely if prefers-reduced-motion is active.
 * @param {string} id - element ID
 * @param {number} target - final value
 * @param {boolean} isInteger - format as integer vs decimal
 * @param {function(number): string} [formatter] - optional value formatter (e.g. formatMAD)
 */
function setKPINumber(id, target, isInteger = true, formatter = null) {
  const el = document.getElementById(id);
  if (!el) return;

  const safeTarget = asMetric(target);
  el.classList.remove('kpi-metric--error');

  const formatValue = (value) => {
    const safe = asMetric(value);
    if (formatter) return formatter(safe);
    return isInteger ? Math.round(safe) : safe.toFixed(1);
  };

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced || safeTarget === 0 || typeof gsap === 'undefined') {
    el.textContent = formatValue(safeTarget);
    return;
  }

  const proxy = { val: 0 };

  gsap.to(proxy, {
    val: safeTarget,
    duration: 0.9,
    ease: 'power3.out',
    ...(isInteger ? { roundProps: 'val' } : {}),
    onUpdate: () => {
      el.textContent = formatValue(proxy.val);
    },
  });
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const safe = text == null ? '—' : String(text);
  el.textContent = safe;
  el.classList.toggle('kpi-metric--error', false);
}

function formatMAD(amount) {
  return new Intl.NumberFormat('fr-MA', {
    style: 'decimal', maximumFractionDigits: 0
  }).format(amount);
}

function formatThousandsFR(value) {
  return String(Math.round(asMetric(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Updates the hero recovery banner: patient count + estimated MAD revenue range.
 * @param {number} patientCount
 */
function updateRecoveryMetrics(patientCount) {
  const count = asMetric(patientCount);
  const patientsEl = document.getElementById('patients-recovered-count');
  const revenueEl = document.getElementById('estimated-revenue-range');

  if (patientsEl) {
    patientsEl.textContent = formatThousandsFR(count);
    patientsEl.classList.remove('skeleton', 'kpi-metric--error');
  }

  if (!revenueEl) return;

  if (count === 0) {
    revenueEl.textContent = '0 MAD';
  } else {
    const minRevenue = count * 800;
    const maxRevenue = count * 1500;
    revenueEl.textContent = `${formatThousandsFR(minRevenue)} - ${formatThousandsFR(maxRevenue)} MAD`;
  }
  revenueEl.classList.remove('skeleton', 'kpi-metric--error');
}

function formatMADShort(amount) {
  if (amount >= 1000) return (amount / 1000).toFixed(0) + ' 000';
  return String(amount);
}

/* ═══════════════════════════════════════════════════════════════════════════
   GSAP + LENIS — global motion stack
   ═══════════════════════════════════════════════════════════════════════════ */

/** @type {import('lenis').default | null} */
let lenisInstance = null;

/**
 * Lenis smooth scroll synced to GSAP ticker.
 * Call once on boot (client portal + doctor dashboard).
 */
function initMotionStack() {
  if (lenisInstance || typeof Lenis === 'undefined' || typeof gsap === 'undefined') return;

  lenisInstance = new Lenis({
    duration: 1.2,
    smoothWheel: true,
    touchMultiplier: 1.5,
  });

  lenisInstance.on('scroll', () => {
    /* Hook point: ScrollTrigger.update() if you add scroll-linked animations later */
  });

  gsap.ticker.add((time) => {
    lenisInstance.raf(time * 1000);
  });
  gsap.ticker.lagSmoothing(0);
}

/* ── App mode: Client Portal (#reserver) vs Doctor Dashboard ─────────────── */

const CLIENT_HASH = '#reserver';

function isClientPortalRoute() {
  return window.location.hash === CLIENT_HASH
    || window.location.hash === '#booking'
    || new URLSearchParams(window.location.search).get('view') === 'reserver';
}

function setAppMode(mode) {
  const isClient = mode === 'client';
  document.body.classList.toggle('mode-client', isClient);
  document.body.classList.toggle('mode-doctor', !isClient);
}

function enterClientPortal(replaceHash = true) {
  document.body.classList.remove('auth-gate-active');
  setAppMode('client');
  if (replaceHash && window.location.hash !== CLIENT_HASH) {
    history.replaceState(null, '', CLIENT_HASH);
  }
  initMotionStack();
  initClientBooking();
}

function enterDoctorApp() {
  setAppMode('doctor');
  const base = window.location.pathname + window.location.search;
  const hash = viewKeyFromHash(window.location.hash) ? window.location.hash : DEFAULT_VIEW_HASH;
  history.replaceState(null, '', `${base}${hash}`);

  if (!document.body.classList.contains('auth-gate-active')) {
    initializeDoctorDashboard();
    unlockDashboard();
    syncTabFromHash();
  }
}

function initAppMode() {
  if (isClientPortalRoute()) {
    enterClientPortal(false);
    return;
  }

  setAppMode('doctor');

  document.getElementById('link-doctor-app')?.addEventListener('click', (e) => {
    e.preventDefault();
    enterDoctorApp();
  });

  window.addEventListener('hashchange', () => {
    if (isClientPortalRoute()) {
      enterClientPortal(false);
    } else if (document.body.classList.contains('mode-client')) {
      enterDoctorApp();
    } else if (document.body.classList.contains('mode-doctor')) {
      syncTabFromHash();
    }
  });
}

/* ── Client Booking Portal — multi-step wizard (Cal.com hook) ────────────── */

const BOOKING_STATE = {
  step: 1,
  serviceId: '',
  serviceLabel: '',
  slotLabel: 'À confirmer via Cal.com',
};

/** GSAP step transition: slide out left, fade new step in from right */
function animateBookingStep(fromEl, toEl, direction = 1) {
  if (typeof gsap === 'undefined') {
    fromEl.hidden = true;
    fromEl.classList.remove('is-active');
    toEl.hidden = false;
    toEl.classList.add('is-active');
    return;
  }

  const outX = direction > 0 ? -20 : 20;
  const inFromX = direction > 0 ? 20 : -20;

  gsap.to(fromEl, {
    x: outX,
    opacity: 0,
    duration: 0.4,
    ease: 'power2.out',
    onComplete: () => {
      fromEl.hidden = true;
      fromEl.classList.remove('is-active');
      gsap.set(fromEl, { clearProps: 'transform,opacity' });

      toEl.hidden = false;
      toEl.classList.add('is-active');
      gsap.fromTo(
        toEl,
        { x: inFromX, opacity: 0 },
        { x: 0, opacity: 1, duration: 0.4, ease: 'power2.out' }
      );
    },
  });
}

function updateBookingProgress(step) {
  document.querySelectorAll('[data-step-indicator]').forEach((el) => {
    const n = Number(el.dataset.stepIndicator);
    el.classList.toggle('is-active', n === step);
    el.classList.toggle('is-done', n < step);
  });
}

function goToBookingStep(nextStep) {
  const fromEl = document.querySelector('.booking-step.is-active');
  const toEl = document.getElementById(`booking-step-${nextStep}`);
  if (!fromEl || !toEl || nextStep === BOOKING_STATE.step) return;

  const direction = nextStep > BOOKING_STATE.step ? 1 : -1;
  BOOKING_STATE.step = nextStep;
  updateBookingProgress(nextStep);
  animateBookingStep(fromEl, toEl, direction);
}

function initClientBooking() {
  const wizard = document.getElementById('booking-wizard');
  if (!wizard || wizard.dataset.initialized === 'true') return;
  wizard.dataset.initialized = 'true';

  const btnStep1Next = document.getElementById('btn-step1-next');
  const btnStep2Back = document.getElementById('btn-step2-back');
  const btnStep2Next = document.getElementById('btn-step2-next');
  const btnStep3Back = document.getElementById('btn-step3-back');
  const btnConfirm   = document.getElementById('btn-booking-confirm');
  const summaryService = document.getElementById('summary-service');
  const summarySlot    = document.getElementById('summary-slot');
  const successEl      = document.getElementById('booking-success');

  document.querySelectorAll('.service-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.service-card').forEach((c) => c.classList.remove('is-selected'));
      card.classList.add('is-selected');
      BOOKING_STATE.serviceId = card.dataset.service || '';
      BOOKING_STATE.serviceLabel = card.dataset.serviceLabel || card.textContent.trim();
      if (btnStep1Next) btnStep1Next.disabled = false;
    });
  });

  btnStep1Next?.addEventListener('click', () => goToBookingStep(2));

  btnStep2Back?.addEventListener('click', () => goToBookingStep(1));
  btnStep2Next?.addEventListener('click', () => {
    /* TODO: read selected slot from Cal.com embed callback */
    if (summaryService) summaryService.textContent = BOOKING_STATE.serviceLabel || '—';
    if (summarySlot) summarySlot.textContent = BOOKING_STATE.slotLabel;
    goToBookingStep(3);
  });

  btnStep3Back?.addEventListener('click', () => goToBookingStep(2));

  btnConfirm?.addEventListener('click', async () => {
    if (typeof gsap !== 'undefined') {
      gsap.to(btnConfirm, {
        scale: 0.95,
        duration: 0.1,
        yoyo: true,
        repeat: 1,
        ease: 'power2.inOut',
      });
    }

    /*
     * n8n webhook hook — POST final booking payload:
     *   fetch('/webhook/final-booking-engine-v2', {
     *     method: 'POST',
     *     headers: { 'Content-Type': 'application/json' },
     *     body: JSON.stringify({
     *       service: BOOKING_STATE.serviceId,
     *       serviceLabel: BOOKING_STATE.serviceLabel,
     *       slot: BOOKING_STATE.slotLabel,
     *       clinic: 'temara-mall',
     *     }),
     *   });
     */
    if (successEl) {
      successEl.hidden = false;
      btnConfirm.disabled = true;
    }
  });
}

/* ── Doctor Hub — metric stagger + patient accordion ─────────────────────── */

const DOCTOR_HUB_ANIM = {
  openDuration: 0.35,
  closeDuration: 0.22,
};

function animateDoctorHubMetrics() {
  const cards = document.querySelectorAll('#view-doctor-hub .doctor-metric-card');
  if (!cards.length || typeof gsap === 'undefined') return;

  gsap.set(cards, { y: 15, opacity: 0 });
  gsap.to(cards, {
    y: 0,
    opacity: 1,
    duration: 0.3,
    stagger: 0.08,
    ease: 'power2.out',
    overwrite: true,
  });
}

function togglePatientRow(row) {
  const details = row.querySelector('.patient-row__details');
  if (!details || typeof gsap === 'undefined') return;

  const isOpen = row.classList.contains('is-open');

  if (isOpen) {
    gsap.to(details, {
      height: 0,
      duration: DOCTOR_HUB_ANIM.closeDuration,
      ease: 'power2.in',
      onComplete: () => row.classList.remove('is-open'),
    });
    return;
  }

  document.querySelectorAll('#doctor-patient-list .patient-row.is-open').forEach((openRow) => {
    if (openRow === row) return;
    const openDetails = openRow.querySelector('.patient-row__details');
    openRow.classList.remove('is-open');
    gsap.to(openDetails, { height: 0, duration: DOCTOR_HUB_ANIM.closeDuration, ease: 'power2.in' });
  });

  row.classList.add('is-open');
  gsap.fromTo(
    details,
    { height: 0 },
    { height: 'auto', duration: DOCTOR_HUB_ANIM.openDuration, ease: 'power2.out' }
  );
}

function initDoctorHub() {
  const list = document.getElementById('doctor-patient-list');
  if (!list || list.dataset.initialized === 'true') return;
  list.dataset.initialized = 'true';

  list.querySelectorAll('.patient-row__details').forEach((el) => {
    gsap.set(el, { height: 0, overflow: 'hidden' });
  });

  list?.addEventListener('click', (e) => {
    const header = e.target.closest('.patient-row__header');
    if (!header) return;
    const row = header.closest('.patient-row');
    if (row) togglePatientRow(row);
  });
}

/* ── End-of-Day Production Digest (Baserow roster) ───────────────────────── */

function looksLikeRosterRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return (
    Object.prototype.hasOwnProperty.call(obj, 'id') ||
    Object.prototype.hasOwnProperty.call(obj, 'Patient (Nom Complet)') ||
    Object.prototype.hasOwnProperty.call(obj, 'Date & Heure du RDV') ||
    Object.prototype.hasOwnProperty.call(obj, 'Clean_Name')
  );
}

function parseRosterResponse(payload) {
  if (payload == null) return [];

  if (Array.isArray(payload)) return payload;

  if (typeof payload !== 'object') return [];

  if (looksLikeRosterRecord(payload)) return [payload];

  const arrayKeys = ['data', 'results', 'items', 'records', 'appointments', 'body', 'json'];
  for (const key of arrayKeys) {
    if (Array.isArray(payload[key])) return payload[key];
    if (looksLikeRosterRecord(payload[key])) return [payload[key]];
  }

  if (payload.json && typeof payload.json === 'object' && !Array.isArray(payload.json)) {
    return [payload.json];
  }

  const values = Object.values(payload);
  if (values.length && values.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    return values;
  }

  return [];
}

function unwrapRosterPayload(payload) {
  if (payload && typeof payload === 'object' && payload.ok === true && 'data' in payload) {
    const inner = payload.data;
    if (Array.isArray(inner)) return inner;
    if (looksLikeRosterRecord(inner)) return [inner];
    return parseRosterResponse(inner);
  }
  return payload;
}

function normalizeDoctorAppointment(raw) {
  const item = raw?.json && typeof raw.json === 'object' && !Array.isArray(raw.json)
    ? raw.json
    : raw;

  if (!item || typeof item !== 'object') return null;

  const statusRaw =
    item['Statut du RDV'] ??
    item.statut ??
    item.status;

  const rawDate =
    item['Date & Heure du RDV'] ??
    item.startTime ??
    item.start_time ??
    item.datetime ??
    item.date;

  const baserowRowId = parseBaserowRowId(item.id ?? item.ID ?? item.row_id ?? item.rowId);

  const patientName =
    item['Patient (Nom Complet)'] ??
    item.Clean_Name ??
    item.Nom ??
    item.nom ??
    item.name ??
    'Non spécifié';

  const treatment =
    item['Motif de Consultation'] ??
    item.motif ??
    item.treatment ??
    'Consultation';

  const phone = String(
    item['Téléphone (WhatsApp)'] ??
    item.Clean_Phone ??
    item.telephone ??
    item.phone ??
    ''
  ).trim();

  const email = String(
    item['Email Contact'] ??
    item.email ??
    ''
  ).trim();

  const observations = String(
    item['Observations Médicales'] ??
    item.observations ??
    ''
  ).trim();

  const insurance = String(
    item['N° d\'Assurance'] ??
    item['Couverture Médicale'] ??
    item.insurance ??
    '—'
  ).trim();

  const amountRaw =
    item['Montant (MAD)'] ??
    item.amount ??
    item.montant ??
    0;
  const amount = Number(amountRaw);
  const safeAmount = Number.isFinite(amount) ? amount : 0;

  return {
    id: baserowRowId ?? item.id,
    rowId: baserowRowId,
    name: String(patientName).trim() || 'Non spécifié',
    treatment: String(treatment).trim() || 'Consultation',
    status: String(extractBaserowFieldValue(statusRaw) || 'Confirmé').trim(),
    rawDate,
    time: formatDoctorAppointmentTime(rawDate),
    phone,
    email,
    observations,
    insurance,
    amount: safeAmount,
  };
}

function parseBaserowRowId(raw) {
  if (raw == null || raw === '') return null;
  const numericId = Number(raw);
  return Number.isFinite(numericId) ? numericId : null;
}

function getTodayDateKeyCasablanca() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
}

function isAppointmentToday(rawDate) {
  if (rawDate == null || rawDate === '') return false;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' }) === getTodayDateKeyCasablanca();
}

function normalizeDigestStatus(status) {
  return String(status || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u2019/g, "'");
}

/** Master status vocabulary — must match Assistant STATUS_OPTIONS */
const DIGEST_SEEN_KEYS = new Set(
  ['Confirmé', 'En salle d\'attente', 'En soin', 'Terminé'].map(normalizeDigestStatus)
);
const DIGEST_CANCELLED_KEYS = new Set(
  ['No-show', 'Annulé'].map(normalizeDigestStatus)
);
DIGEST_CANCELLED_KEYS.add('noshow');

function isDigestSeenStatus(status) {
  const key = normalizeDigestStatus(status);
  if (DIGEST_SEEN_KEYS.has(key)) return true;
  return key.includes('salle') && key.includes('attente');
}

function isDigestCancelledStatus(status) {
  return DIGEST_CANCELLED_KEYS.has(normalizeDigestStatus(status));
}

function filterTodayAppointments(records) {
  const dated = records.filter((record) => record?.rawDate != null && record.rawDate !== '');
  if (!dated.length) return records;
  return records.filter((record) => isAppointmentToday(record.rawDate));
}

/* ── Kinetic Data Counters ─────────────────────────────────────────────── */
function animateKineticCounter(elementId, targetValue, suffix = '') {
  const element = document.getElementById(elementId);
  if (!element) return;

  const numericTarget = Number(targetValue);
  if (!Number.isFinite(numericTarget)) return;

  if (typeof gsap === 'undefined') {
    element.innerHTML = `${numericTarget}${suffix}`;
    return;
  }

  const proxy = { val: 0 };
  const isInteger = Number.isInteger(numericTarget);

  gsap.to(proxy, {
    val: numericTarget,
    duration: 0.8,
    ease: 'power3.out',
    ...(isInteger ? { roundProps: 'val' } : {}),
    onUpdate: () => {
      const displayVal = isInteger ? proxy.val : Math.round(proxy.val);
      element.innerHTML = `${displayVal}${suffix}`;
    },
  });
}

function setDigestFinalValues({ totalVus, totalAnnules, totalRevenue, progressPercent }) {
  const vusEl = document.getElementById('digest-patients-vus');
  const annulEl = document.getElementById('digest-annulations');
  const revEl = document.getElementById('digest-revenue');
  const progEl = document.getElementById('digest-progress');

  if (vusEl) vusEl.textContent = String(totalVus);
  if (annulEl) annulEl.textContent = String(totalAnnules);
  if (revEl) revEl.textContent = `${totalRevenue} MAD`;
  if (progEl) progEl.style.width = `${progressPercent}%`;
}

function startDigestKineticCounters({ instant = false } = {}) {
  if (digestKineticsStarted || !pendingDigestKinetics) return;
  digestKineticsStarted = true;

  const { totalVus, totalAnnules, totalRevenue, progressPercent } = pendingDigestKinetics;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (instant || prefersReducedMotion) {
    setDigestFinalValues(pendingDigestKinetics);
    return;
  }

  animateKineticCounter('digest-patients-vus', totalVus);
  animateKineticCounter('digest-annulations', totalAnnules);
  animateKineticCounter('digest-revenue', totalRevenue, ' MAD');

  const progEl = document.getElementById('digest-progress');
  if (progEl) {
    progEl.style.width = '0%';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        progEl.style.width = `${progressPercent}%`;
      });
    });
  }
}

function computeEndOfDayDigest(records) {
  const todayRows = filterTodayAppointments(records);

  const totalVus = todayRows.filter((record) => isDigestSeenStatus(record.status)).length;
  const totalAnnules = todayRows.filter((record) => isDigestCancelledStatus(record.status)).length;
  const totalRevenue = totalVus * CONFIG.DIGEST_REVENUE_PER_PATIENT_MAD;

  return { totalVus, totalAnnules, totalRevenue };
}

function formatDoctorAppointmentTime(rawDate) {
  if (rawDate == null || rawDate === '') return '—';
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Casablanca',
  });
}

function isDoctorEmergencyRecord(record) {
  const motif = String(record?.treatment || '').toLowerCase();
  const status = normalizeDigestStatus(record?.status);
  return motif.includes('urgence') || status.includes('urgence');
}

function isDoctorActiveTriageRecord(record) {
  const key = normalizeDigestStatus(record?.status);
  return key !== 'annule' && key !== 'termine';
}

function sortDoctorAppointmentsByTime(a, b) {
  const timeA = new Date(a?.rawDate || 0).getTime();
  const timeB = new Date(b?.rawDate || 0).getTime();
  return timeA - timeB;
}

async function updateRosterStatus(selectEl, previousStatus) {
  const bookingId = selectEl.dataset.bookingId || '';
  const newStatus = selectEl.value;

  selectEl.disabled = true;
  selectEl.classList.add('status-updating');
  selectEl.classList.remove('status-success', 'status-error');

  try {
    const response = await fetch(CONFIG.UPDATE_STATUS_PROXY, {
      method: 'POST',
      credentials: 'include',
      headers: getApiAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ bookingId, newStatus }),
    });

    const responseText = await response.text();
    let responsePayload = responseText;
    try {
      responsePayload = responseText ? JSON.parse(responseText) : null;
    } catch {
      // keep raw text
    }
    console.log('[Roster Status] Success | HTTP: ' + response.status + ' | OK: ' + response.ok);

    assertAuthorizedResponse(response);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${String(responseText).slice(0, 200)}`);
    }

    if (responsePayload && typeof responsePayload === 'object' && responsePayload.ok === false) {
      const detail = responsePayload.error || responsePayload.details || 'Réponse proxy invalide';
      throw new Error(String(detail));
    }

    selectEl.classList.remove('status-updating');
    selectEl.classList.add('status-success');
    showDashboardToast('Statut mis à jour avec succès.', 'success');

    setTimeout(() => {
      selectEl.classList.remove('status-success');
      selectEl.disabled = false;
    }, 2000);
  } catch (error) {
    console.error('[Roster Status] Update failed:', error?.message || error);
    selectEl.value = previousStatus;
    selectEl.classList.remove('status-updating');
    selectEl.classList.add('status-error');
    selectEl.disabled = false;
    const msg = String(error?.message || '');
    if (!msg.includes('Session expirée')) {
      showDashboardToast('Erreur: Impossible de mettre à jour le statut.', 'error');
    }
    setTimeout(() => selectEl.classList.remove('status-error'), 2000);
  }
}

function createDoctorTriageRow(record) {
  const tr = document.createElement('tr');

  const timeCell = document.createElement('td');
  timeCell.textContent = record.time || '';

  const nameCell = document.createElement('td');
  nameCell.textContent = record.name || '';

  const treatmentCell = document.createElement('td');
  treatmentCell.textContent = record.treatment || '';

  const statusCell = document.createElement('td');
  statusCell.appendChild(createStatusIndicator(record.status || 'Confirmé'));

  tr.append(timeCell, nameCell, treatmentCell, statusCell);
  return tr;
}

function renderDoctorTriageRoster(records) {
  const waitingBody = document.getElementById('doctor-waiting-room-body');
  const emergencyBody = document.getElementById('doctor-emergencies-body');
  if (!waitingBody || !emergencyBody) return;

  const todayRows = filterTodayAppointments(records)
    .filter(isDoctorActiveTriageRecord)
    .sort(sortDoctorAppointmentsByTime);

  const emergencies = todayRows.filter(isDoctorEmergencyRecord);
  const waiting = todayRows.filter((record) => !isDoctorEmergencyRecord(record));

  waitingBody.replaceChildren();
  if (!waiting.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.className = 'triage-empty';
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = 'Aucun patient en attente';
    emptyRow.appendChild(cell);
    waitingBody.appendChild(emptyRow);
  } else {
    const fragment = document.createDocumentFragment();
    waiting.forEach((record) => fragment.appendChild(createDoctorTriageRow(record)));
    waitingBody.appendChild(fragment);
  }

  emergencyBody.replaceChildren();
  if (!emergencies.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.className = 'triage-empty';
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = 'Aucune urgence signalée';
    emptyRow.appendChild(cell);
    emergencyBody.appendChild(emptyRow);
  } else {
    const fragment = document.createDocumentFragment();
    emergencies.forEach((record) => fragment.appendChild(createDoctorTriageRow(record)));
    emergencyBody.appendChild(fragment);
  }
}

function renderEndOfDayDigest({ totalVus, totalAnnules, totalRevenue }) {
  const dailyGoal = CONFIG.DIGEST_DAILY_GOAL_MAD;
  const progressPercent = Math.min(100, (totalRevenue / dailyGoal) * 100);

  digestKineticsStarted = false;
  pendingDigestKinetics = { totalVus, totalAnnules, totalRevenue, progressPercent };

  const vusEl = document.getElementById('digest-patients-vus');
  const annulEl = document.getElementById('digest-annulations');
  const revEl = document.getElementById('digest-revenue');
  const progEl = document.getElementById('digest-progress');

  if (vusEl) vusEl.textContent = '0';
  if (annulEl) annulEl.textContent = '0';
  if (revEl) revEl.textContent = '0 MAD';
  if (progEl) progEl.style.width = '0%';
}

async function loadDoctorHubData(isSilentSync = false) {
  const crmPanel = document.getElementById('crm-side-panel');
  const panelWasOpen = Boolean(crmPanel?.classList.contains('is-active'));
  const selectedPatientId = document.querySelector('.crm-table-row.is-selected')?.dataset?.patientId ?? null;

  try {
    window.DentaFlowAuth?.requireSession?.();

    const response = await fetch(CONFIG.ROSTER_PROXY, {
      method: 'GET',
      credentials: 'include',
      headers: getApiAuthHeaders({ 'Content-Type': 'application/json' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });

    assertAuthorizedResponse(response);

    const payload = await response.json();

    if (!response.ok) {
      const detail = payload?.details || payload?.error || `HTTP ${response.status}: ${response.statusText}`;
      throw new Error(detail);
    }

    if (payload && typeof payload === 'object' && payload.ok === false) {
      const detail = payload.details || payload.error || 'Erreur proxy roster';
      throw new Error(detail);
    }

    const unwrapped = unwrapRosterPayload(payload);
    const records = parseRosterResponse(unwrapped)
      .map(normalizeDoctorAppointment)
      .filter(Boolean);

    const digest = computeEndOfDayDigest(records);
    if (isSilentSync) {
      const progressPercent = Math.min(100, (digest.totalRevenue / CONFIG.DIGEST_DAILY_GOAL_MAD) * 100);
      setDigestFinalValues({ ...digest, progressPercent });
    } else {
      renderEndOfDayDigest(digest);
    }

    renderDoctorTriageRoster(records);
    renderCRMTable(records);

    if (panelWasOpen && selectedPatientId) {
      const row = document.querySelector(`.crm-table-row[data-patient-id="${selectedPatientId}"]`);
      const patient = crmPatientsById[selectedPatientId];
      if (row && patient) {
        populateCrmSidePanel(patient);
        row.classList.add('is-selected');
        crmPanel.classList.add('is-active');
        crmPanel.setAttribute('aria-hidden', 'false');
      }
    }

    if (!isSilentSync) {
      queueOsBootSequence();
    }
  } catch (err) {
    if (isUnauthorizedError(err)) return;
    console.error('[Doctor Hub] Digest load failed:', err?.message || err);
    if (isSilentSync) return;
    renderEndOfDayDigest({ totalVus: 0, totalAnnules: 0, totalRevenue: 0 });
    renderDoctorTriageRoster([]);
    renderCRMTable([]);
    queueOsBootSequence();
  }
}

const DOCTOR_OS_BOOT_SELECTORS = {
  sidebar: '.sidebar',
  triagePanels: '.brutalist-triage-grid .brutalist-triage-panel',
  digestTargets: '.brutalist-digest-container, .brutalist-digest-container .digest-metric',
  triageRows: '#doctor-waiting-room-body tr:not(.triage-empty), #doctor-emergencies-body tr:not(.triage-empty)',
};

function collectDoctorOsBootTargets() {
  return [
    document.querySelector(DOCTOR_OS_BOOT_SELECTORS.sidebar),
    ...document.querySelectorAll(DOCTOR_OS_BOOT_SELECTORS.triagePanels),
    ...document.querySelectorAll(DOCTOR_OS_BOOT_SELECTORS.digestTargets),
    ...document.querySelectorAll(DOCTOR_OS_BOOT_SELECTORS.triageRows),
  ].filter(Boolean);
}

function revealDoctorOsBootFallback() {
  document.body.classList.remove('os-boot-pending');
  const targets = collectDoctorOsBootTargets();
  if (typeof gsap !== 'undefined' && targets.length) {
    gsap.set(targets, { opacity: 1, x: 0, y: 0, clearProps: 'opacity,transform' });
  } else {
    targets.forEach((el) => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
  }
  startDigestKineticCounters({ instant: typeof gsap === 'undefined' });
}

function queueOsBootSequence() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => runDoctorOsBootSequence());
  });
}

function runDoctorOsBootSequence() {
  if (osBootSequencePlayed) return;
  osBootSequencePlayed = true;

  try {
    if (typeof gsap === 'undefined') {
      revealDoctorOsBootFallback();
      return;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealDoctorOsBootFallback();
      return;
    }

    const sidebar = document.querySelector(DOCTOR_OS_BOOT_SELECTORS.sidebar);
    const triagePanels = document.querySelectorAll(DOCTOR_OS_BOOT_SELECTORS.triagePanels);
    const digestTargets = document.querySelectorAll(DOCTOR_OS_BOOT_SELECTORS.digestTargets);
    const triageRows = document.querySelectorAll(DOCTOR_OS_BOOT_SELECTORS.triageRows);
    const bootTargets = collectDoctorOsBootTargets();
    const hasBootContent =
      sidebar || triagePanels.length || digestTargets.length || triageRows.length;

    if (!hasBootContent) {
      revealDoctorOsBootFallback();
      return;
    }

    const bootTimeline = gsap.timeline({
      defaults: { ease: 'power4.out', duration: 0.4 },
    });

    bootTimeline.eventCallback('onComplete', () => {
      document.body.classList.remove('os-boot-pending');
      if (bootTargets.length) {
        gsap.set(bootTargets, { clearProps: 'opacity,transform' });
      }
    });

    if (sidebar) {
      bootTimeline.fromTo(
        sidebar,
        { x: -25, opacity: 0 },
        { x: 0, opacity: 1, immediateRender: true }
      );
    }

    if (triagePanels.length) {
      bootTimeline.fromTo(
        triagePanels,
        { y: 15, opacity: 0 },
        { y: 0, opacity: 1, stagger: 0.05, immediateRender: false },
        '-=0.25'
      );
    }

    if (digestTargets.length) {
      bootTimeline.fromTo(
        digestTargets,
        { y: 20, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          immediateRender: false,
          onStart: () => startDigestKineticCounters(),
        },
        '-=0.15'
      );
    } else if (pendingDigestKinetics) {
      startDigestKineticCounters();
    }

    if (triageRows.length) {
      bootTimeline.fromTo(
        triageRows,
        { opacity: 0 },
        { opacity: 1, stagger: 0.02, duration: 0.28, ease: 'power4.out', immediateRender: false },
        '-=0.18'
      );
    }
  } catch (err) {
    console.error('[Doctor OS Boot] Animation failed:', err?.message || err);
    revealDoctorOsBootFallback();
  }
}

window.queueDoctorOsBootSequence = queueOsBootSequence;
window.revealDoctorOsBootFallback = revealDoctorOsBootFallback;

/* ── Team Messages (Assistant → Doctor handoff feed) ─────────────────────── */

let teamNotesCache = [];
let teamNotesRefreshTimer = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractBaserowFieldValue(field) {
  if (field == null) return '';
  if (typeof field === 'string' || typeof field === 'number') return String(field);
  if (typeof field === 'boolean') return field;
  if (typeof field === 'object' && field.value != null) return field.value;
  return field;
}

function parseTeamNotesResponse(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return [];

  if (payload.Message != null || payload.message != null || payload.text != null) {
    return [payload];
  }

  const arrayKeys = ['data', 'results', 'items', 'records', 'notes', 'body', 'json'];
  for (const key of arrayKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  if (payload.json && typeof payload.json === 'object' && !Array.isArray(payload.json)) {
    return [payload.json];
  }

  return [];
}

function normalizeTeamNote(raw) {
  const item = raw?.json && typeof raw.json === 'object' && !Array.isArray(raw.json)
    ? raw.json
    : raw;

  if (!item || typeof item !== 'object') return null;

  const text = String(item.Message ?? item.message ?? item.text ?? '').trim();
  if (!text) return null;

  const categoryRaw = item['Catégorie'] ?? item.Categorie ?? item.category ?? 'Info';
  const category = String(extractBaserowFieldValue(categoryRaw) || 'Info').trim() || 'Info';

  const authorRaw = item.Auteur ?? item.author;
  const author = String(extractBaserowFieldValue(authorRaw) || '').trim();

  const pinnedRaw = item['Épinglé'] ?? item.Epingle ?? item.pinned ?? false;
  const pinnedValue = extractBaserowFieldValue(pinnedRaw);
  const pinned =
    pinnedRaw === true ||
    pinnedValue === true ||
    pinnedValue === 1 ||
    String(pinnedValue).toLowerCase() === 'true' ||
    String(pinnedValue).toLowerCase() === 'oui';

  const timeRaw = item.Heure ?? item.time ?? item.heure ?? '';
  let time = String(extractBaserowFieldValue(timeRaw) || '').trim();
  if (time.includes('T')) {
    const parsed = new Date(time);
    if (!Number.isNaN(parsed.getTime())) {
      time = parsed.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
  }

  const id = item.id ?? item.ID ?? `note-${String(text).slice(0, 24)}-${time || Date.now()}`;

  return { id, text, category, author, pinned, time };
}

function parseTeamNoteTime(time) {
  const [hours, minutes] = String(time || '00:00').split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function sortTeamNotes(notes) {
  return [...notes].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return parseTeamNoteTime(b.time) - parseTeamNoteTime(a.time);
  });
}

function isUrgentTeamNote(note) {
  return String(note.category || '').trim().toLowerCase() === 'urgent';
}

function createTeamNoteElement(note) {
  const urgent = isUrgentTeamNote(note);
  const categorySlug = String(note.category || 'Info').toLowerCase().replace(/\s+/g, '-');

  const article = document.createElement('article');
  article.className = `team-message${urgent ? ' team-message--urgent' : ''}${note.pinned ? ' team-message--pinned' : ''}`;
  article.dataset.noteId = String(note.id);
  article.setAttribute('role', 'article');

  const indicator = document.createElement('span');
  indicator.className = 'team-message__indicator';
  indicator.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'team-message__body';

  const meta = document.createElement('div');
  meta.className = 'team-message__meta';

  if (note.time) {
    const timeEl = document.createElement('time');
    timeEl.className = 'team-message__time';
    timeEl.dateTime = note.time;
    timeEl.textContent = note.time;
    meta.appendChild(timeEl);
  }

  if (note.author) {
    const authorSpan = document.createElement('span');
    authorSpan.className = 'team-message__author';
    authorSpan.textContent = note.author;
    meta.appendChild(authorSpan);
  }

  const categorySpan = document.createElement('span');
  categorySpan.className = `team-message__category team-message__category--${categorySlug}`;
  const categoryDot = document.createElement('span');
  categoryDot.className = 'status-pill__dot';
  categoryDot.setAttribute('aria-hidden', 'true');
  categorySpan.append(categoryDot, document.createTextNode(note.category || 'Info'));
  meta.appendChild(categorySpan);

  if (note.pinned) {
    const pinSpan = document.createElement('span');
    pinSpan.className = 'team-message__pin';
    pinSpan.setAttribute('aria-label', 'Message épinglé');
    pinSpan.textContent = 'Épinglé';
    meta.appendChild(pinSpan);
  }

  const textP = document.createElement('p');
  textP.className = 'team-message__text';
  textP.textContent = note.text || '';

  body.append(meta, textP);
  article.append(indicator, body);
  return article;
}

function renderTeamNotesList(notes, { errorMessage = null } = {}) {
  const listEl = document.getElementById('team-notes-list');
  const syncEl = document.getElementById('team-notes-sync');
  if (!listEl) return;

  listEl.setAttribute('aria-busy', 'false');
  listEl.replaceChildren();

  if (errorMessage) {
    window.DentaFlowDom?.appendParagraph(listEl, 'team-messages-empty team-messages-empty--error', errorMessage);
    if (syncEl) syncEl.textContent = 'Hors-ligne';
    return;
  }

  const sorted = sortTeamNotes(notes);

  if (!sorted.length) {
    window.DentaFlowDom?.appendParagraph(listEl, 'team-messages-empty', 'Aucun message de l\'équipe pour le moment.');
    if (syncEl) syncEl.textContent = 'À jour';
    return;
  }

  const fragment = document.createDocumentFragment();
  sorted.forEach((note) => fragment.appendChild(createTeamNoteElement(note)));
  listEl.appendChild(fragment);

  if (syncEl) {
    const now = new Date().toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    syncEl.textContent = `Sync ${now}`;
  }
}

async function loadTeamNotes() {
  const listEl = document.getElementById('team-notes-list');
  const syncEl = document.getElementById('team-notes-sync');

  if (listEl && !teamNotesCache.length) {
    listEl.setAttribute('aria-busy', 'true');
  }
  if (syncEl && !teamNotesCache.length) {
    syncEl.textContent = 'Chargement…';
  }

  try {
    window.DentaFlowAuth?.requireSession?.();

    const response = await fetch(CONFIG.TEAM_NOTES_PROXY, {
      method: 'GET',
      credentials: 'include',
      headers: getApiAuthHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });

    assertAuthorizedResponse(response);

    const rawText = await response.text();
    let payload;
    try {
      payload = rawText.trim() ? JSON.parse(rawText) : [];
    } catch {
      throw new Error('Réponse non-JSON');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const rawRows = parseTeamNotesResponse(payload);
    teamNotesCache = rawRows.map(normalizeTeamNote).filter(Boolean);
    renderTeamNotesList(teamNotesCache);
  } catch (error) {
    if (isUnauthorizedError(error)) return;
    console.error('[Team Notes] Load failed:', error?.message || error);
    if (teamNotesCache.length) {
      renderTeamNotesList(teamNotesCache);
      if (syncEl) syncEl.textContent = 'Sync partielle';
    } else {
      renderTeamNotesList([], {
        errorMessage: 'Impossible de charger les messages — vérifiez la connexion n8n.',
      });
    }
  }
}

function initTeamNotesSync() {
  loadTeamNotes();
  if (teamNotesRefreshTimer) clearInterval(teamNotesRefreshTimer);
  teamNotesRefreshTimer = setInterval(loadTeamNotes, CONFIG.TEAM_NOTES_REFRESH_MS);
}

/* ── SMART SYNC — silent background refresh ─────────────────────────────── */
let smartSyncInitialized = false;
let smartSyncIntervalId = null;
let lastSmartSyncAt = 0;
let smartSyncInFlight = false;

function initSmartSync() {
  if (smartSyncInitialized) return;
  if (document.body.classList.contains('mode-client')) return;
  if (document.body.classList.contains('mode-assistant')) return;

  smartSyncInitialized = true;

  let syncTimeout;

  async function runSmartSync() {
    if (document.body.classList.contains('auth-gate-active')) return;
    if (smartSyncInFlight) return;
    if (Date.now() - lastSmartSyncAt < CONFIG.SMART_SYNC_DEBOUNCE_MS) return;

    smartSyncInFlight = true;
    lastSmartSyncAt = Date.now();

    try {
      await Promise.all([
        loadDashboard(true),
        loadDoctorHubData(true),
      ]);
    } finally {
      smartSyncInFlight = false;
    }
  }

  if (smartSyncIntervalId) clearInterval(smartSyncIntervalId);
  smartSyncIntervalId = setInterval(runSmartSync, CONFIG.SMART_SYNC_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      runSmartSync();
    }, 0);
  });
}

window.DentaFlowAuth?.registerLogoutTeardown?.(async function teardownDoctorSession() {
  if (teamNotesRefreshTimer) {
    clearInterval(teamNotesRefreshTimer);
    teamNotesRefreshTimer = null;
  }
  if (smartSyncIntervalId) {
    clearInterval(smartSyncIntervalId);
    smartSyncIntervalId = null;
  }
  smartSyncInitialized = false;
  doctorDashboardInitialized = false;
  if (hoursChart) { hoursChart.destroy(); hoursChart = null; }
  if (acceptanceChart) { acceptanceChart.destroy(); acceptanceChart = null; }
  if (recoveryOpChart) { recoveryOpChart.destroy(); recoveryOpChart = null; }
  if (flowOpChart) { flowOpChart.destroy(); flowOpChart = null; }
});
