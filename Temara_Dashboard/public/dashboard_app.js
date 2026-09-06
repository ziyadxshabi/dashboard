/* --- SECURITY — auth gate handled by auth.js --- */
const AUTH_CONFIG = {
  SESSION_KEY: 'dentaflow_session',
};

function getApiAuthHeaders(extra = {}) {
  const authHeaders = typeof window.DentaFlowAuth?.getAuthHeaders === 'function'
    ? window.DentaFlowAuth.getAuthHeaders()
    : { Accept: 'application/json' };

  return {
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

function askConfirm(message) {
  if (typeof window.DentaFlowConfirm?.confirmAction === 'function') {
    return window.DentaFlowConfirm.confirmAction(message);
  }
  return Promise.resolve(true);
}

function unlockDashboard({ skipDashboardFetch = false } = {}) {
  if (
    typeof window.DentaFlowAuth?.isAuthenticated === 'function' &&
    !window.DentaFlowAuth.isAuthenticated()
  ) {
    void window.DentaFlowAuth.logout?.();
    return;
  }

  const overlay = doctorEl('login-overlay');
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
  if (typeof loadPatientDirectory === 'function') {
    loadPatientDirectory();
  }
  if (typeof loadWaitlistForOps === 'function') {
    loadWaitlistForOps();
  }
  if (typeof loadGaps === 'function') {
    loadGaps();
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
 * Daily Pulse Dashboard — doctor shell
 * Clinique Dentaire Témara Mall · DentaFlow OS
 *
 * Fetches clinic KPIs from PostgreSQL via GET /api/dashboard-data
 * and paints the doctor hub, KPI cards, and operational charts.
 */

'use strict';

function __domById(id) {
  return document['getElementById'](id);
}

function doctorShell() {
  return __domById('doctor-shell') || document;
}

function doctorEl(id) {
  if (!id) return null;
  const root = doctorShell();
  if (root && root !== document) {
    const scoped = root.querySelector('[id="' + String(id).replace(/"/g, '\\"') + '"]');
    if (scoped) return scoped;
  }
  return __domById(id);
}

function doctorQuery(selector) {
  return doctorShell().querySelector(selector);
}

function doctorQueryAll(selector) {
  return doctorShell().querySelectorAll(selector);
}

/* ── CONFIG ─────────────────────────────────────────────────────────────────
 * DATA_URL: GET /api/dashboard-data (clinic-scoped Postgres KPIs).
 * DAILY_GOAL_PATIENTS: Daily patient-count target (localStorage).
 * REFRESH_INTERVAL_MS: Auto-refresh interval (300000 = 5 minutes).
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
    if (!Number.isFinite(val) || val < 1) return null;
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
  DATA_URL:             '/api/dashboard-data',
  ROSTER_PROXY:         '/api/roster',
  UPDATE_STATUS_PROXY:  '/api/update-status',
  TEAM_NOTES_PROXY:     '/api/team-notes',
  WAITLIST_PROXY:       '/api/waitlist',
  FILL_GAP_PROXY:       '/api/fill-gap',
  BULK_SMS_PROXY:       '/api/bulk-sms',
  DAILY_GOAL_PATIENTS:  12,
  REFRESH_INTERVAL_MS:  300_000,
  SMART_SYNC_INTERVAL_MS: 180_000,
  SMART_SYNC_DEBOUNCE_MS: 15_000,
  TEAM_NOTES_REFRESH_MS: 60_000,
  ROSTER_ENDPOINT:      '/api/roster',
  CURRENCY_LOCALE:      'fr-MA',
  CURRENCY:             'MAD',
};

const bootDailyGoal = loadPersistedDailyGoal();
if (bootDailyGoal != null) {
  CONFIG.DAILY_GOAL_PATIENTS = bootDailyGoal;
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

/* ── DASHBOARD DATA ────────────────────────────────────────────────────────
 * GET /api/dashboard-data returns clinic-scoped KPI aggregates from PostgreSQL.
 */

/* ── CHART INSTANCES (module-level so we can destroy on refresh) ─────────── */
let hoursChart      = null;
let acceptanceChart = null;
let recoveryOpChart = null;
let flowOpChart     = null;
let lastChartData   = null;
let lastKpiPayload  = null;
let chartPeriod     = 'today';
let lastTodayRoster = [];
let lastDirectory   = [];
let lastWaitlist    = [];
let lastGaps        = [];
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
  initMobileNav();
  initChartToggles();
  initWaitlistForm();
  initWaitlistAdmin();
  initStatusBoardFilters();
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

  doctorQueryAll('.dashboard-view').forEach(view => {
    view.setAttribute('aria-hidden', view.classList.contains('active') ? 'false' : 'true');
    if (view.classList.contains('active')) {
      view.classList.add('view-enter-ready');
    }
  });

  if (activeView === 'calendar') {
    initDashboardCalendar();
  }

  if (typeof window.refreshLucideIcons === 'function') {
    window.refreshLucideIcons(doctorEl('doctor-shell') || document);
  }
}

window.initializeDoctorDashboard = initializeDoctorDashboard;
window.bootDoctorDashboard = initializeDoctorDashboard;

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
  return window.DentaFlowRowUI?.extractInitials
    ? window.DentaFlowRowUI.extractInitials(fullName)
    : '??';
}

function getMatteChipModifier(label) {
  return window.DentaFlowRowUI?.getMatteChipModifier
    ? window.DentaFlowRowUI.getMatteChipModifier(label)
    : 'attente';
}

function createMatteChip(label) {
  return window.DentaFlowRowUI.createMatteChip(label);
}

function createStatusDot(label) {
  return window.DentaFlowRowUI.createStatusDot(label);
}

function createStatusIndicator(label) {
  return window.DentaFlowRowUI.createPriorityIndicator(label);
}

function createPatientAvatar(name) {
  return window.DentaFlowRowUI.createPatientAvatar(name);
}

function createPatientIdentity(name) {
  return window.DentaFlowRowUI.createPatientIdentity(name);
}

function getWaitlistPriorityLabel(appt) {
  return window.DentaFlowRowUI.getWaitlistPriorityLabel(appt);
}

function createWaitlistTableRow(appt) {
  return window.DentaFlowRowUI.createWaitlistTableRow(appt);
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

function initDashboardCalendar() {
  const el = doctorEl('dashboard-cal-inline');
  if (!el) return;

  if (dashboardCalendar) {
    requestAnimationFrame(() => dashboardCalendar.updateSize());
    return;
  }

  if (typeof FullCalendar === 'undefined') {
    console.error('[Calendar] FullCalendar library not loaded');
    return;
  }

  const Ops = window.DentaFlowBookingOps;
  el.innerHTML = '';

  dashboardCalendar = new FullCalendar.Calendar(el, {
    initialView: 'timeGridWeek',
    headerToolbar: {
      left:   'prev,next today',
      center: 'title',
      right:  'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
    },
    locale: 'fr',
    timeZone: 'Africa/Casablanca',
    firstDay: 1,
    height: 'auto',
    expandRows: true,
    slotMinTime: '08:00:00',
    slotMaxTime: '19:00:00',
    nowIndicator: true,
    allDaySlot: false,
    eventTimeFormat: {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
    datesSet: (info) => {
      const range = Ops?.ymdFromView(info);
      if (range) void loadCalendarRange(range.from, range.to);
    },
    eventClick: (info) => {
      const bookingId = info.event.extendedProps?.bookingId;
      const key = info.event.extendedProps?.statusKey;
      const nextByKey = {
        confirme: "En salle d'attente",
        en_salle: 'En soin',
        en_soin: 'Termine',
      };
      const nextStatus = nextByKey[key];
      if (!bookingId || !nextStatus) return;
      void askConfirm(`Passer ce rendez-vous en « ${nextStatus} » ?`).then(async (ok) => {
        if (!ok) return;
        try {
          window.DentaFlowAuth?.requireSession?.();
          const response = await fetch(CONFIG.UPDATE_STATUS_PROXY, {
            method: 'POST',
            credentials: 'include',
            headers: getApiAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ bookingId, newStatus: nextStatus }),
          });
          assertAuthorizedResponse(response);
          const payload = await response.json();
          if (!response.ok || payload?.ok === false) {
            throw new Error(payload?.error || 'Mise à jour du statut impossible');
          }
          showDashboardToast('Statut mis à jour.', 'success');
          await loadDoctorHubData(true);
          const range = Ops?.ymdFromView(info.view);
          if (range) void loadCalendarRange(range.from, range.to);
        } catch (err) {
          if (isUnauthorizedError(err)) return;
          showDashboardToast(err?.message || 'Impossible de mettre à jour le statut.', 'error');
        }
      });
    },
  });

  dashboardCalendar.render();
}

/* ── HERO GREETING & DATE ────────────────────────────────────────────────── */
function initHeroGreeting() {
  const greetingEl = doctorEl('greeting-time');
  const dateEl     = doctorEl('hero-date');
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

  const views = doctorQueryAll('.dashboard-view');
  const target = doctorEl(targetId);

  views.forEach(view => {
    const isTarget = view.id === targetId;
    view.classList.toggle('active', isTarget);
    view.classList.toggle('view-enter-ready', isTarget);
    view.setAttribute('aria-hidden', isTarget ? 'false' : 'true');
  });

  doctorQueryAll('.nav-link, .tab-link').forEach(link => {
    const isActive = link.dataset.nav === viewKey;
    link.classList.toggle('is-active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });

  activeView = viewKey;

  const activeTab = doctorQuery(`.tab-link[data-nav="${viewKey}"]`);
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

function initMobileNav() {
  const root = doctorEl('doctor-shell') || document;
  const btn = root.querySelector('.mobile-menu-btn');
  const drawer = root.querySelector('.mobile-drawer');
  const closeBtn = root.querySelector('.mobile-drawer__close');
  if (!btn || !drawer) return;
  if (btn.dataset.mobileNavBound === 'true') return;
  btn.dataset.mobileNavBound = 'true';

  function toggleMenu(open) {
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
  }

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMenu(!drawer.classList.contains('open'));
  });
  closeBtn?.addEventListener('click', () => toggleMenu(false));
  drawer.querySelectorAll('.nav-link[data-nav]').forEach((link) => {
    link.addEventListener('click', () => toggleMenu(false));
  });
  document.addEventListener('click', (event) => {
    if (!drawer.classList.contains('open')) return;
    if (drawer.contains(event.target) || btn.contains(event.target)) return;
    toggleMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleMenu(false);
  });
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
  const toggle  = doctorEl('chart-toggle');
  const slider  = doctorEl('chart-toggle-slider');
  const buttons = toggle?.querySelectorAll('.chart-toggle-btn');
  if (!toggle || !slider || !buttons?.length) return;

  function activate(btn, index) {
    buttons.forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    slider.style.transform = `translateX(${index * 100}%)`;
  }

  buttons.forEach((btn, index) => {
    btn?.addEventListener('click', () => {
      activate(btn, index);
      const nextPeriod = btn.dataset.period || 'today';
      if (nextPeriod !== chartPeriod) {
        chartPeriod = nextPeriod;
        void loadDashboard();
      }
    });
  });
}

/* ── TODAY'S SCHEDULE FEED ───────────────────────────────────────────────── */
function renderAppointmentsList(records) {
  const container = doctorEl('appointments-list');
  if (!container) return;
  const rows = Array.isArray(records) ? records : lastTodayRoster;
  container.replaceChildren();
  hideSkeleton('roster');
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'schedule-empty';
    empty.textContent = 'Aucun rendez-vous aujourd’hui.';
    container.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((record) => {
    fragment.appendChild(createApptCardElement({
      time: record.time,
      name: record.name,
      phone: record.phone,
      treatment: record.treatment,
      tagClass: record.status,
    }));
  });
  container.appendChild(fragment);
}

function renderWaitlistPanel(rows) {
  const container = doctorEl('waitlist-panel-list');
  if (!container) return;
  const waitlist = Array.isArray(rows) ? rows : lastWaitlist;
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
    hideSkeleton('waitlist');
    return;
  }

  if (ui?.clearEmptyState) ui.clearEmptyState('waitlist-empty-state');
  if (table) table.hidden = false;

  const fragment = document.createDocumentFragment();
  waitlist.forEach((appt) => fragment.appendChild(createWaitlistTableRow(appt)));
  container.appendChild(fragment);
  hideSkeleton('waitlist');
}

/* ── NO-SHOW RECOVERY — WAITLIST FORM ────────────────────────────────────── */
function initWaitlistForm() {
  const form = doctorEl('waitlist-form');
  if (!form) return;

  const V = window.DentaFlowValidators;
  V?.bindField(doctorEl('waitlist-name'), 'name', { required: true });
  V?.bindField(doctorEl('waitlist-phone'), 'phone', { required: true });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const btn        = doctorEl('waitlist-submit-btn');
    const nameEl     = doctorEl('waitlist-name');
    const phoneEl    = doctorEl('waitlist-phone');
    const priorityEl = doctorEl('waitlist-priority');
    const consentEl  = doctorEl('waitlist-sms-consent');

    if (!btn || !nameEl || !phoneEl || !priorityEl) return;

    const nameOk = V ? V.validateInput(nameEl, 'name', { required: true }) : Boolean(nameEl.value.trim());
    const phoneOk = V ? V.validateInput(phoneEl, 'phone', { required: true }) : Boolean(phoneEl.value.trim());
    if (!nameOk || !phoneOk) {
      if (!nameOk) nameEl.focus();
      else phoneEl.focus();
      return;
    }

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
        void loadWaitlistForOps();

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
  const container = doctorEl('waitlist-panel-list');
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
  const resolved = window.DentaFlowTheme?.applyTheme
    ? window.DentaFlowTheme.applyTheme(theme)
    : (theme === 'pearl-clinic' || theme === 'light' ? 'pearl-clinic' : 'oak-lounge');
  if (!window.DentaFlowTheme?.applyTheme) {
    document.documentElement.setAttribute('data-theme', resolved);
  }
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
  const oakBtn   = doctorEl('theme-btn-oak');
  const pearlBtn = doctorEl('theme-btn-pearl');
  const isPearl    = theme === 'pearl-clinic';

  oakBtn?.classList.toggle('is-active', !isPearl);
  pearlBtn?.classList.toggle('is-active', isPearl);
  oakBtn?.setAttribute('aria-pressed', !isPearl ? 'true' : 'false');
  pearlBtn?.setAttribute('aria-pressed', isPearl ? 'true' : 'false');
}

function initThemeSwitcher() {
  const oakBtn   = doctorEl('theme-btn-oak');
  const pearlBtn = doctorEl('theme-btn-pearl');
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

function getProfileDefaults() {
  return {
    profileName: window.DentaFlowTheme?.getSessionDisplayName?.() || 'Praticien',
    profileSpecialty: window.DentaFlowTheme?.getSessionRoleLabel?.('doctor') || 'Chirurgien-dentiste',
  };
}

function extractInitials(fullName) {
  return window.DentaFlowRowUI?.extractInitials
    ? window.DentaFlowRowUI.extractInitials(fullName)
    : extractPatientInitials(fullName);
}

function applyUserProfile(name, specialty) {
  const defaults = getProfileDefaults();
  const displayName = (name ?? '').trim() || defaults.profileName;
  const displayRole = (specialty ?? '').trim() || defaults.profileSpecialty;
  const initials    = extractInitials(displayName);

  const avatarEl = doctorEl('profile-avatar');
  const nameEl   = doctorEl('profile-name');
  const roleEl   = doctorEl('profile-role');
  const heroEl   = doctorEl('hero-profile-name');

  if (avatarEl) avatarEl.textContent = initials;
  if (nameEl)   nameEl.textContent   = displayName;
  if (roleEl)   roleEl.textContent   = displayRole;
  if (heroEl)   heroEl.textContent   = displayName;
}

function initUserProfile() {
  const saved = loadSettings();
  const nameEl      = doctorEl('settings-profile-name');
  const specialtyEl = doctorEl('settings-profile-specialty');

  const defaults = getProfileDefaults();
  const profileName      = saved.profileName      ?? defaults.profileName;
  const profileSpecialty = saved.profileSpecialty ?? defaults.profileSpecialty;

  if (nameEl)      nameEl.value      = profileName;
  if (specialtyEl) specialtyEl.value = profileSpecialty;

  applyUserProfile(profileName, profileSpecialty);
}

function initAccountCardMenu() {
  doctorEl('account-menu-settings')?.addEventListener('click', () => {
    if (VIEW_MAP.settings) navigateToView('settings');
  });
  doctorEl('account-menu-logout')?.addEventListener('click', (event) => {
    event.preventDefault();
    void askConfirm('Se déconnecter ?').then((ok) => {
      if (ok) void window.DentaFlowAuth?.logout?.();
    });
  });
  doctorEl('mobile-logout-btn')?.addEventListener('click', (event) => {
    event.preventDefault();
    void askConfirm('Se déconnecter ?').then((ok) => {
      if (ok) void window.DentaFlowAuth?.logout?.();
    });
  });
}

function initSettings() {
  const persistedGoal = loadPersistedDailyGoal();
  if (persistedGoal != null) {
    CONFIG.DAILY_GOAL_PATIENTS = persistedGoal;
  }

  const saved = loadSettings();
  const goalEl = doctorEl('settings-daily-goal');
  if (goalEl) {
    if (persistedGoal != null) {
      goalEl.value = persistedGoal;
    } else if (saved.dailyGoal) {
      goalEl.value = saved.dailyGoal;
      CONFIG.DAILY_GOAL_PATIENTS = saved.dailyGoal;
    }
  }

  const smsToggle = doctorEl('settings-sms-toggle');
  const emailToggle = doctorEl('settings-email-toggle');
  if (smsToggle && smsToggle.dataset.demoBound !== 'true') {
    smsToggle.checked = saved.smsReminders !== false;
  }
  if (emailToggle && emailToggle.dataset.demoBound !== 'true') {
    emailToggle.checked = saved.emailReminders !== false;
  }
}

function applyDoctorDailyGoal(value) {
  const val = Number(value);
  if (!Number.isFinite(val) || val < 1) return;
  CONFIG.DAILY_GOAL_PATIENTS = val;
  saveSettings({ dailyGoal: val });
  persistDailyGoal(val);
  if (lastKpiPayload) bindKpiMicroCharts(lastKpiPayload);
}

window.applyDoctorDailyGoal = applyDoctorDailyGoal;

function loadSettings() {
  return { ...volatileSettings };
}

function saveSettings(partial) {
  Object.assign(volatileSettings, partial);
}

const SECURITY_ACCOUNT_LABELS = {
  doc: 'Compte Docteur (Admin)',
  asst: 'Compte Assistante (Staff)',
};

let securityToastTimer = null;

function showDashboardToast(message, type = 'info') {
  const toast = doctorEl('assistant-toast');
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
  return window.DentaFlowSelect?.init?.({
    root: doctorEl('security-account-root'),
    hidden: doctorEl('security-account-input'),
    trigger: doctorEl('security-account-trigger'),
    list: doctorEl('security-account-list'),
    label: doctorEl('security-account-value'),
    defaultValue: 'doc',
    once: true,
  });
}

function initSecurityManagement() {
  const form = doctorEl('security-access-form');
  if (!form) return;
  initSecurityAccountSelect();
  if (typeof window.DentaFlowAuth?.bindPasswordForm === 'function') {
    window.DentaFlowAuth.bindPasswordForm(document);
  }
}

/* ── CRM PATIENT SEARCH ──────────────────────────────────────────────────── */
function initCrmSearch() {
  const searchEl = doctorEl('crm-search');
  const tbody    = doctorEl('crm-table-body');
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
  const Ops = window.DentaFlowBookingOps;
  return {
    id: record.id ?? record.phone_e164 ?? record.phone,
    name: record.name || 'Non spécifié',
    phone: record.phone || record.phone_e164 || '',
    email: record.email || '',
    motif: record.last_treatment || record.treatment || 'Consultation',
    visit_count: Number(record.visit_count) || 0,
    no_show_count: Number(record.no_show_count) || 0,
    cancel_count: Number(record.cancel_count) || 0,
    last_visit: record.last_visit || null,
    next_visit: record.next_visit || null,
    recent_visits: Array.isArray(record.recent_visits) ? record.recent_visits : [],
    last_visit_label: Ops?.formatDayLabel(record.last_visit) || '—',
    next_visit_label: Ops?.formatDayLabel(record.next_visit) || '—',
  };
}

function renderCRMTable(records) {
  const tbody = doctorEl('crm-table-body');
  if (!tbody) return;

  const rows = Array.isArray(records) ? records.filter(Boolean) : [];
  crmPatientsById = {};
  tbody.replaceChildren();

  if (!rows.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.className = 'crm-table-empty';
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'Aucun patient trouvé';
    emptyRow.appendChild(cell);
    tbody.appendChild(emptyRow);
    hideSkeleton('crm');
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

    const cells = [
      patient.name,
      patient.phone || '—',
      patient.motif,
      String(patient.visit_count),
      patient.last_visit_label,
      patient.next_visit_label,
    ];
    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  hideSkeleton('crm');
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
  const Ops = window.DentaFlowBookingOps;
  setText('crm-panel-name', patient.name);

  const subtitleEl = doctorEl('crm-panel-subtitle');
  if (subtitleEl) {
    subtitleEl.textContent = [patient.phone, patient.email].filter(Boolean).join(' · ');
  }

  const statutEl = doctorEl('crm-panel-statut');
  if (statutEl) {
    const label = patient.next_visit ? 'Prochain RDV' : (patient.last_visit ? 'Vu' : '—');
    statutEl.textContent = label;
  }

  setText('crm-panel-visits', String(patient.visit_count || 0));
  setText('crm-panel-noshows', String(patient.no_show_count || 0));
  setText('crm-panel-cancels', String(patient.cancel_count || 0));
  setText('crm-panel-next', patient.next_visit_label || '—');
  setText('crm-panel-email', patient.email || '—');
  setText('crm-panel-motif', patient.motif);

  const timeline = doctorEl('crm-panel-timeline');
  if (timeline) {
    timeline.replaceChildren();
    const visits = patient.recent_visits || [];
    if (!visits.length) {
      const empty = document.createElement('li');
      empty.textContent = 'Aucun historique de rendez-vous.';
      timeline.appendChild(empty);
    } else {
      visits.forEach((visit) => {
        const li = document.createElement('li');
        li.className = 'crm-timeline__item';
        const when = Ops?.formatDayLabel(visit.starts_at) || '';
        const time = Ops?.casablancaHm(visit.starts_at) || '';
        li.innerHTML = `<strong>${Ops?.escapeHtml(visit.treatment_name || 'Consultation')}</strong>
          <span>${Ops?.escapeHtml(when)} ${Ops?.escapeHtml(time)} · ${Ops?.escapeHtml(visit.status || '')}</span>
          ${visit.notes ? `<p>${Ops.escapeHtml(visit.notes)}</p>` : ''}`;
        timeline.appendChild(li);
      });
    }
  }

  const notesEl = doctorEl('crm-panel-notes');
  if (notesEl) {
    const related = (teamNotesCache || []).filter((note) => {
      const name = String(note.patient_name || '').toLowerCase();
      const visitIds = new Set((patient.recent_visits || []).map((visit) => String(visit.id)));
      const bookingMatch = note.booking_id && visitIds.has(String(note.booking_id));
      return bookingMatch || (name && name === String(patient.name || '').toLowerCase());
    });
    notesEl.textContent = related.length
      ? related.map((note) => `${note.author || 'Équipe'}: ${note.message || note.text}`).join('\n')
      : 'Aucune note liée à ce patient.';
  }
}

function openCrmSidePanel(patient, selectedRow) {
  const root = doctorEl('crm-side-panel');
  if (!root) return;

  populateCrmSidePanel(patient);

  doctorQueryAll('.crm-table-row.is-selected').forEach(row => {
    row.classList.remove('is-selected');
  });
  selectedRow?.classList.add('is-selected');

  root.classList.add('is-active');
  root.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    doctorEl('crm-side-panel-close')?.focus();
  });
}

function closeCrmSidePanel() {
  const root = doctorEl('crm-side-panel');
  if (!root || !root.classList.contains('is-active')) return;

  root.classList.remove('is-active');
  root.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';

  doctorQueryAll('.crm-table-row.is-selected').forEach(row => {
    row.classList.remove('is-selected');
  });
}

function initCrmSidePanel() {
  const root     = doctorEl('crm-side-panel');
  const overlay  = doctorEl('crm-side-panel-overlay');
  const closeBtn = doctorEl('crm-side-panel-close');
  const tbody    = doctorEl('crm-table-body');
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
  const textarea = doctorEl('doctor-custom-sms-text');
  const submitBtn = doctorEl('btn-doctor-custom-sms');
  const counter = doctorEl('doctor-custom-sms-count');
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

    const confirmed = await askConfirm('Envoyer un SMS à plusieurs patients ? Cette action est irréversible.');
    if (!confirmed) return;

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
  const form     = doctorEl('sms-campaign-form');
  const textarea = doctorEl('sms-campaign-body');
  const counter  = doctorEl('sms-char-count');
  const counterWrap = counter?.parentElement;
  const submitBtn = doctorEl('sms-campaign-submit');
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
function showSkeleton(section) {
  const sk = doctorEl(`${section}-skeleton`);
  const content = doctorEl(`${section}-content`);
  if (sk) {
    sk.hidden = false;
    sk.style.display = 'block';
  }
  if (content) {
    content.hidden = true;
    content.style.display = 'none';
  }
}

function hideSkeleton(section) {
  const sk = doctorEl(`${section}-skeleton`);
  const content = doctorEl(`${section}-content`);
  if (sk) {
    sk.hidden = true;
    sk.style.display = 'none';
  }
  if (content) {
    content.hidden = false;
    content.style.display = '';
  }
}

function applySkeletonState() {
  setSyncState('loading', 'Actualisation…');
  showSkeleton('stats');
  showSkeleton('roster');
  ['val-patients','val-noshows','val-new','banner-occupancy','banner-recovered','banner-noshow-rate'].forEach(id => {
    const el = doctorEl(id);
    if (el) el.classList.add('skeleton');
  });
}

function clearSkeletonState() {
  hideSkeleton('stats');
  hideSkeleton('roster');
  ['val-patients','val-noshows','val-new','banner-occupancy','banner-recovered','banner-noshow-rate'].forEach(id => {
    const el = doctorEl(id);
    if (el) el.classList.remove('skeleton');
  });
}

/* ── SYNC DOT STATE ──────────────────────────────────────────────────────── */
function setSyncState(state, label) {
  const dot  = doctorEl('sync-dot');
  const text = doctorEl('sync-label');
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
    accepted_plans:  0,
    pending_plans:   0,
  };
}

/** Pristine empty UI — em-dashes in stat cards, zeroed charts, no error strings in KPIs. */
function renderDashboardFallback() {
  clearSkeletonState();

  const noshowCard = doctorEl('card-noshows');
  noshowCard?.classList.remove('kpi-card--danger');

  ['patients-recovered-count', 'estimated-revenue-range', 'val-patients', 'val-noshows', 'val-new'].forEach((id) => {
    const el = doctorEl(id);
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
    throw new Error('Erreur de synchronisation avec la base de données');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Erreur de synchronisation avec la base de données');
  }
}

/* ── MAIN DATA FETCH ─────────────────────────────────────────────────────── */
async function loadDashboard(isSilentSync = false) {
  const errorBanner = doctorEl('error-banner');

  try {
    window.DentaFlowAuth?.requireSession?.();

    if (!isSilentSync) {
      applySkeletonState();
    }

    const response = await fetch(`${CONFIG.DATA_URL}?period=${encodeURIComponent(chartPeriod)}`, {
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
          msg = `Erreur de synchronisation avec la base de données — ${errBody.details.slice(0, 160)}`;
        } else if (typeof errBody?.error === 'string' && errBody.error.trim()) {
          msg = `Erreur de synchronisation avec la base de données — ${errBody.error}`;
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

      throw new Error(detail ? `Erreur de synchronisation avec la base de données — ${detail}` : (raw.error || 'Erreur de synchronisation avec la base de données'));
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
  if (Array.isArray(raw) && raw.length > 0) {
    raw = raw[0]?.json ?? raw[0];
  }

  if (raw && typeof raw === 'object' && raw.ok === true) {
    raw = raw.data ?? raw.metrics ?? {};
  }

  const out = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : asMetric(item)));
    } else if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
      out[k] = Number(v);
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else if (v != null && typeof v === 'object') {
      out[k] = v;
    } else if (v != null && typeof v !== 'object') {
      out[k] = asMetric(v);
    }
  }
  return out;
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
  const newPatients = asMetric(data.pending_plans);

  const trendPatientsSvg = doctorQuery('#trend-patients svg');
  updateSparkline(trendPatientsSvg?.querySelector('path, polyline'), patientsToday, 24);

  const trendNoshowsSvg = doctorQuery('#trend-noshows svg');
  updateBarChart(trendNoshowsSvg, noShows);

  const trendNewSvg = doctorQuery('#trend-new svg');
  updateSparkline(trendNewSvg?.querySelector('path, polyline'), newPatients, 10);

  const kpiScope = doctorQuery('.kpi-row');
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
  const el = doctorEl(id);
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
  if (!Array.isArray(data.week_patients) || data.week_patients.length < 7) {
    return null;
  }
  return labels.map((label, index) => ({
    label,
    value: asMetric(data.week_patients[index]),
  }));
}

function normalizeChartSeries(data) {
  if (Array.isArray(data)) {
    if (data.length < 7) return null;
    return data.slice(0, 7).map((point, index) => ({
      label: String(point?.label ?? getLast7DayLabels()[index] ?? ''),
      value: asMetric(point?.value),
    }));
  }
  return buildSevenDayTrendFromData(data);
}

function renderChartEmptyState(container, message) {
  if (!container) return;
  container.replaceChildren();
  container.classList.add('is-chart-empty');
  const empty = document.createElement('p');
  empty.className = 'chart-empty';
  empty.textContent = message || 'Données insuffisantes';
  container.appendChild(empty);
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
  const container = doctorEl(containerId);
  if (!container) return;

  const series = normalizeChartSeries(data);
  if (!series || !series.length) {
    renderChartEmptyState(container, 'Données insuffisantes');
    return;
  }
  container.classList.remove('is-chart-empty');
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
  const pending_plans     = asMetric(data?.pending_plans ?? data?.pending_quotes);
  const cancelled         = asMetric(data?.cancelled);
  const absences          = no_shows + cancelled;
  const Ops = window.DentaFlowBookingOps;

  setKpiTrend('trend-patients', buildSparklineSvg(null, { tone: 'gold' }));
  setKpiTrend('trend-noshows', buildBarChartSvg(null, { tone: 'danger' }));
  setKpiTrend('trend-new', buildSparklineSvg(null, { tone: 'muted' }));

  renderDoctorHubCharts(data);
  bindKpiMicroCharts(data);
  updateHonestBanner(data);

  setKPINumber('hub-val-patients', patients_today, true);
  setKPINumber('hub-val-pending', pending_plans, true);
  setKPINumber('hub-val-noshows', no_shows, true);
  const occupancyEl = doctorEl('hub-val-occupancy');
  if (occupancyEl) occupancyEl.textContent = Ops?.occupancyLabel(data.occupancy) || '—';

  setText('hub-delta-patients', patients_today > 0 ? 'Aujourd\'hui' : 'Aucun RDV');
  setText('hub-delta-pending', pending_plans > 0
    ? `${pending_plans} en attente`
    : 'Aucun en attente');
  setText('hub-delta-noshows', no_shows > 0
    ? `${no_shows} créneau${no_shows > 1 ? 'x' : ''} libre${no_shows > 1 ? 's' : ''}`
    : 'Aucune absence');
  setText('hub-delta-occupancy', data.occupancy
    ? `${asMetric(data.occupancy.booked_min)} / ${asMetric(data.occupancy.capacity_min)} min`
    : 'Fauteuil 08h–19h');

  refreshOperationalCharts(data);

  const overviewPanel = doctorEl('overview-gap-panel');
  if (overviewPanel) {
    overviewPanel.hidden = asMetric(data.no_shows) <= 0;
    if (!overviewPanel.hidden) renderGapList(lastGaps, doctorEl('overview-gap-list'));
  }

  setKPINumber('val-patients', patients_today, true);
  setText('sub-patients', 'Rendez-vous du jour');

  const noshowCard = doctorEl('card-noshows');
  if (noshowCard) {
    if (absences > 0) {
      noshowCard.classList.add('kpi-card--danger');
      const el = doctorEl('val-noshows');
      if (el) {
        el.textContent = absences;
        el.style.color = '';
      }
      setText('sub-noshows', absences === 1
        ? '1 créneau à combler'
        : `${absences} créneaux à combler`
      );
    } else {
      noshowCard.classList.remove('kpi-card--danger');
      setKPINumber('val-noshows', 0, true);
      setText('sub-noshows', 'Aucune annulation');
    }
  }

  setKPINumber('val-new', pending_plans, true);
  setText('sub-new',
    pending_plans === 0
      ? 'Aucun rendez-vous en attente'
      : `${pending_plans} rendez-vous en attente`
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
  const mix = data.status_mix && typeof data.status_mix === 'object' ? data.status_mix : {};
  const flowLabels = ['Confirmés', 'En salle', 'En soin', 'En attente', 'No-show', 'Annulé'];
  const flowKeys = ['Confirme', "En salle d'attente", 'En soin', 'En attente', 'No-show', 'Annule'];
  return {
    recovery: {
      labels: ['Encore en attente', 'Créneaux placés'],
      values: [asMetric(data.waitlist_active), asMetric(data.waitlist_filled)],
    },
    flow: {
      labels: flowLabels,
      values: flowKeys.map((key) => asMetric(mix[key])),
    },
  };
}

function setCanvasChartEmpty(canvasEl, message) {
  const wrap = canvasEl?.closest('.chart-canvas-wrap') || canvasEl?.parentElement;
  if (!wrap) return;
  wrap.classList.add('is-empty');
  let empty = wrap.querySelector('.chart-empty');
  if (!empty) {
    empty = document.createElement('p');
    empty.className = 'chart-empty';
    wrap.appendChild(empty);
  }
  empty.hidden = false;
  empty.textContent = message || 'Données insuffisantes';
}

function clearCanvasChartEmpty(canvasEl) {
  const wrap = canvasEl?.closest('.chart-canvas-wrap') || canvasEl?.parentElement;
  if (!wrap) return;
  wrap.classList.remove('is-empty');
  const empty = wrap.querySelector('.chart-empty');
  if (empty) empty.hidden = true;
}

function createRecoveryAreaGradient(canvas) {
  const ctx = canvas.getContext('2d');
  const height = canvas.parentElement?.clientHeight || 300;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(200, 158, 102, 0.2)');
  gradient.addColorStop(1, 'rgba(200, 158, 102, 0)');
  return gradient;
}

function getFlowBarColors(count = 6) {
  const gold = OPERATIONAL_CHART_GOLD;
  const muted = OPERATIONAL_CHART_MUTED_BAR;
  return Array.from({ length: count }, (_, index) => (index === count - 2 ? gold : muted));
}

function initOperationalCharts(data = {}) {
  if (typeof Chart === 'undefined') return;

  applyChartJsDefaults();
  const payload = buildOperationalChartPayload(data);

  const recoveryCtx = doctorEl('recoveryChart');
  if (recoveryCtx) {
    if (recoveryOpChart) {
      recoveryOpChart.destroy();
      recoveryOpChart = null;
    }
    const recoverySum = payload.recovery.values.reduce((sum, n) => sum + n, 0);
    if (!recoverySum) {
      setCanvasChartEmpty(recoveryCtx, 'Aucun patient en liste d\'attente pour l\'instant.');
    } else {
      clearCanvasChartEmpty(recoveryCtx);
      recoveryOpChart = new Chart(recoveryCtx, {
        type: 'bar',
        data: {
          labels: payload.recovery.labels,
          datasets: [{
            data: payload.recovery.values,
            backgroundColor: [OPERATIONAL_CHART_MUTED_BAR, OPERATIONAL_CHART_GOLD],
            borderWidth: 0,
            borderRadius: 6,
            borderSkipped: false,
            barThickness: 18,
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
                label: (ctx) => ` ${ctx.label}: ${ctx.parsed.x}`,
              },
            },
          },
          scales: {
            x: {
              beginAtZero: true,
              grid: { display: true, color: OPERATIONAL_CHART_GRID, drawTicks: false },
              border: { display: false },
              ticks: { ...getOperationalChartTickStyle(), precision: 0 },
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

  const flowCtx = doctorEl('flowChart');
  if (flowCtx) {
    if (flowOpChart) {
      flowOpChart.destroy();
      flowOpChart = null;
    }
    clearCanvasChartEmpty(flowCtx);

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
              label: (ctx) => ` ${ctx.label}: ${ctx.parsed.x}`,
            },
          },
        },
        scales: {
          x: {
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
  if (!flowOpChart && !recoveryOpChart) {
    initOperationalCharts(data);
    return;
  }
  initOperationalCharts(data);
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
  const ctx = doctorEl('chart-hours');
  if (!ctx) return;

  const hasHours = keys.some((key) => data?.[key] != null);
  if (!hasHours) {
    if (hoursChart) { hoursChart.destroy(); hoursChart = null; }
    setCanvasChartEmpty(ctx, 'Données insuffisantes');
    return;
  }
  clearCanvasChartEmpty(ctx);
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

  const ctx = doctorEl('chart-acceptance');
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
  const legendEl = doctorEl('pie-legend');
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
  const el = doctorEl(id);
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
  const el = doctorEl(id);
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
function updateHonestBanner(data = {}) {
  const Ops = window.DentaFlowBookingOps;
  setText('banner-occupancy', Ops?.occupancyLabel(data.occupancy) || '—');
  setText(
    'banner-occupancy-helper',
    data.occupancy
      ? `${asMetric(data.occupancy.booked_min)} min réservées / ${asMetric(data.occupancy.capacity_min)} min ouvertes`
      : 'Minutes réservées / plage 08h–19h'
  );
  const recovered = asMetric(data.waitlist_filled);
  setText('banner-recovered', String(recovered));
  setText(
    'banner-recovered-helper',
    recovered
      ? `${recovered} patient${recovered > 1 ? 's' : ''} de la liste d'attente placé${recovered > 1 ? 's' : ''} sur un trou`
      : 'Liste d\'attente placée sur un trou du planning'
  );
  setText('banner-noshow-rate', Ops?.rateLabel(data.no_show_rate) || '—');
  setText(
    'banner-noshow-helper',
    data.no_show_rate == null
      ? 'Pas encore de rendez-vous échus'
      : `${asMetric(data.no_shows)} no-show / rendez-vous échus`
  );
}

function updateRecoveryMetrics(data) {
  updateHonestBanner(data || lastKpiPayload || {});
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

  doctorEl('link-doctor-app')?.addEventListener('click', (e) => {
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
  const toEl = doctorEl(`booking-step-${nextStep}`);
  if (!fromEl || !toEl || nextStep === BOOKING_STATE.step) return;

  const direction = nextStep > BOOKING_STATE.step ? 1 : -1;
  BOOKING_STATE.step = nextStep;
  updateBookingProgress(nextStep);
  animateBookingStep(fromEl, toEl, direction);
}

function initClientBooking() {
  const wizard = doctorEl('booking-wizard');
  if (!wizard || wizard.dataset.initialized === 'true') return;
  wizard.dataset.initialized = 'true';

  const btnStep1Next = doctorEl('btn-step1-next');
  const btnStep2Back = doctorEl('btn-step2-back');
  const btnStep2Next = doctorEl('btn-step2-next');
  const btnStep3Back = doctorEl('btn-step3-back');
  const btnConfirm   = doctorEl('btn-booking-confirm');
  const summaryService = doctorEl('summary-service');
  const summarySlot    = doctorEl('summary-slot');
  const successEl      = doctorEl('booking-success');

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
  const list = doctorEl('doctor-patient-list');
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

  const firstPresent = (...values) => {
    for (const value of values) {
      if (value == null || value === '') continue;
      return value;
    }
    return undefined;
  };

  const statusRaw = firstPresent(item.status, item.statut, item['Statut du RDV']);
  const rawDate = firstPresent(
    item.starts_at,
    item.startTime,
    item.start_time,
    item.datetime,
    item.date,
    item['Date & Heure du RDV']
  );

  const bookingId = String(item.id ?? item.ID ?? item.row_id ?? item.rowId ?? '').trim() || null;

  const patientName = firstPresent(
    item.patient_name,
    item.name,
    item.Nom,
    item.nom,
    item.Clean_Name,
    item['Patient (Nom Complet)']
  ) ?? 'Non spécifié';

  const treatment = firstPresent(
    item.treatment_name,
    item.treatment,
    item.motif,
    item['Motif de Consultation']
  ) ?? 'Consultation';

  const phone = String(
    firstPresent(item.patient_phone, item.phone, item.telephone, item['Téléphone (WhatsApp)']) || ''
  ).trim();

  const email = String(firstPresent(item.email, item['Email Contact']) || '').trim();

  const observations = String(
    firstPresent(item.notes, item.observations, item['Observations Médicales']) || ''
  ).trim();

  const insurance = String(
    firstPresent(item.coverage, item.insurance, item['Couverture Médicale']) || '—'
  ).trim();

  const amountRaw = firstPresent(item.amount, item.montant, item['Montant (MAD)']) ?? 0;
  const amount = Number(amountRaw);
  const safeAmount = Number.isFinite(amount) ? amount : 0;

  return {
    id: bookingId ?? item.id,
    rowId: bookingId,
    name: String(patientName).trim() || 'Non spécifié',
    treatment: String(treatment).trim() || 'Consultation',
    status: String(statusRaw || 'Confirmé').trim(),
    rawDate,
    time: formatDoctorAppointmentTime(rawDate),
    phone,
    duration_min: Number(item.duration_min) || 30,
    starts_at: rawDate,
    notes: observations,
    patient_name: String(patientName).trim() || 'Non spécifié',
    patient_phone: phone,
    treatment_name: String(treatment).trim() || 'Consultation',
    patient_email: email,
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
  const element = doctorEl(elementId);
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

function setDigestFinalValues({ totalVus, totalAnnules, occupancyPct, progressPercent }) {
  const vusEl = doctorEl('digest-patients-vus');
  const annulEl = doctorEl('digest-annulations');
  const occEl = doctorEl('digest-occupancy');
  const progEl = doctorEl('digest-progress');

  if (vusEl) vusEl.textContent = String(totalVus);
  if (annulEl) annulEl.textContent = String(totalAnnules);
  if (occEl) occEl.textContent = `${occupancyPct} %`;
  if (progEl) progEl.style.width = `${progressPercent}%`;
}

function startDigestKineticCounters({ instant = false } = {}) {
  if (digestKineticsStarted || !pendingDigestKinetics) return;
  digestKineticsStarted = true;

  const { totalVus, totalAnnules, occupancyPct, progressPercent } = pendingDigestKinetics;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (instant || prefersReducedMotion) {
    setDigestFinalValues(pendingDigestKinetics);
    return;
  }

  animateKineticCounter('digest-patients-vus', totalVus);
  animateKineticCounter('digest-annulations', totalAnnules);
  animateKineticCounter('digest-occupancy', occupancyPct, ' %');

  const progEl = doctorEl('digest-progress');
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
  const Ops = window.DentaFlowBookingOps;
  const totalVus = todayRows.filter((record) => {
    const key = Ops?.statusKey(record.status) || '';
    return key === 'termine' || key === 'en_salle' || key === 'en_soin';
  }).length;
  const totalAnnules = todayRows.filter((record) => {
    const key = Ops?.statusKey(record.status) || '';
    return key === 'annule' || key === 'no_show';
  }).length;
  const occupancyPct = Number(lastKpiPayload?.occupancy?.pct);
  return { totalVus, totalAnnules, occupancyPct: Number.isFinite(occupancyPct) ? occupancyPct : 0 };
}

function renderEndOfDayDigest({ totalVus, totalAnnules, occupancyPct }) {
  const dailyGoal = CONFIG.DAILY_GOAL_PATIENTS || 12;
  const progressPercent = Math.min(100, (totalVus / dailyGoal) * 100);

  digestKineticsStarted = false;
  pendingDigestKinetics = { totalVus, totalAnnules, occupancyPct, progressPercent };

  const vusEl = doctorEl('digest-patients-vus');
  const annulEl = doctorEl('digest-annulations');
  const occEl = doctorEl('digest-occupancy');
  const progEl = doctorEl('digest-progress');

  if (vusEl) vusEl.textContent = '0';
  if (annulEl) annulEl.textContent = '0';
  if (occEl) occEl.textContent = '0 %';
  if (progEl) progEl.style.width = '0%';
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
    selectEl.removeAttribute('aria-invalid');
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
    selectEl.setAttribute('aria-invalid', 'true');
    selectEl.disabled = false;
    const msg = String(error?.message || '');
    if (!msg.includes('Session expirée')) {
      showDashboardToast('Erreur: Impossible de mettre à jour le statut.', 'error');
    }
    setTimeout(() => {
      selectEl.classList.remove('status-error');
      selectEl.removeAttribute('aria-invalid');
    }, 2000);
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
  const waitingBody = doctorEl('doctor-waiting-room-body');
  const emergencyBody = doctorEl('doctor-emergencies-body');
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
  hideSkeleton('triage');
}

async function loadDoctorHubData(isSilentSync = false) {
  if (!isSilentSync) {
    showSkeleton('triage');
  }

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

    lastTodayRoster = records;
    const occupancyPct = Number(lastKpiPayload?.occupancy?.pct) || 0;
    const digest = computeEndOfDayDigest(records, occupancyPct);
    if (isSilentSync) {
      setDigestFinalValues({
        ...digest,
        progressPercent: Math.min(100, occupancyPct),
      });
    } else {
      renderEndOfDayDigest({ ...digest, occupancyPct });
    }

    renderStatusBoard(records, doctorEl('status-board-urgence-filter')?.checked);
    renderAppointmentsList(records);
    updateOverviewAppointmentCount(records.length);

    const occEl = doctorEl('hub-val-occupancy');
    if (occEl) occEl.textContent = occupancyPct ? `${occupancyPct}%` : '—';

    if (!isSilentSync) {
      queueOsBootSequence();
    }
  } catch (err) {
    if (isUnauthorizedError(err)) return;
    console.error('[Doctor Hub] Digest load failed:', err?.message || err);
    if (isSilentSync) return;
    lastTodayRoster = [];
    renderEndOfDayDigest({ totalVus: 0, totalAnnules: 0, occupancyPct: 0 });
    renderStatusBoard([]);
    renderAppointmentsList([]);
    queueOsBootSequence();
  } finally {
    if (!isSilentSync) {
      hideSkeleton('triage');
    }
  }
}

async function fetchJsonAuthorized(url) {
  window.DentaFlowAuth?.requireSession?.();
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: getApiAuthHeaders({ 'Content-Type': 'application/json' }),
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  });
  assertAuthorizedResponse(response);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.details || payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function loadPatientDirectory() {
  try {
    const payload = await fetchJsonAuthorized(`${CONFIG.ROSTER_PROXY}?view=directory`);
    const rows = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    lastDirectory = rows;
    renderCRMTable(rows);
  } catch (err) {
    if (isUnauthorizedError(err)) return;
    console.error('[CRM] Directory load failed:', err?.message || err);
    lastDirectory = [];
    renderCRMTable([]);
  }
}

async function loadCalendarRange(from, to) {
  if (!dashboardCalendar) return;
  try {
    const payload = await fetchJsonAuthorized(
      `${CONFIG.ROSTER_PROXY}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    const unwrapped = unwrapRosterPayload(payload);
    const records = parseRosterResponse(unwrapped).map(normalizeDoctorAppointment).filter(Boolean);
    dashboardCalendar.removeAllEvents();
    records.forEach((record) => {
      const event = window.DentaFlowBookingOps?.toCalendarEvent(record);
      if (event) dashboardCalendar.addEvent(event);
    });
  } catch (err) {
    if (isUnauthorizedError(err)) return;
    console.error('[Calendar] Range load failed:', err?.message || err);
  }
}

async function loadWaitlistForOps() {
  try {
    const payload = await fetchJsonAuthorized(CONFIG.WAITLIST_PROXY);
    lastWaitlist = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    renderWaitlistPanel(lastWaitlist);
  } catch (err) {
    if (isUnauthorizedError(err)) return;
    lastWaitlist = [];
    renderWaitlistPanel([]);
  }
}

async function loadGaps() {
  try {
    const payload = await fetchJsonAuthorized(`${CONFIG.ROSTER_PROXY}?view=gaps`);
    const pack = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    lastGaps = Array.isArray(pack?.gaps) ? pack.gaps : [];
    renderGapList(lastGaps, doctorEl('gap-list'));
    const overviewHost = doctorEl('overview-gap-list');
    const overviewPanel = doctorEl('overview-gap-panel');
    const noShows = asMetric(lastKpiPayload?.no_shows);
    if (overviewPanel) overviewPanel.hidden = noShows <= 0;
    if (overviewHost && noShows > 0) renderGapList(lastGaps, overviewHost);
  } catch (err) {
    if (isUnauthorizedError(err)) return;
    lastGaps = [];
    renderGapList([], doctorEl('gap-list'));
  }
}

function renderStatusBoard(records, urgencesOnly = false) {
  const lanes = window.DentaFlowBookingOps.partitionStatusBoard(records, urgencesOnly);
  const mapping = [
    ['lane-confirme', 'confirme', lanes.confirme],
    ['lane-en_salle', 'en_salle', lanes.en_salle],
    ['lane-en_soin', 'en_soin', lanes.en_soin],
    ['lane-termine', 'termine', lanes.termine],
  ];
  mapping.forEach(([id, key, items]) => {
    const el = doctorEl(id);
    if (!el) return;
    el.innerHTML = '';
    const countEl = doctorQuery(`.status-board__count[data-count="${key}"]`);
    if (countEl) countEl.textContent = String(items.length);
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'status-board__empty';
      empty.textContent = 'Aucun rendez-vous';
      el.appendChild(empty);
      return;
    }
    items.forEach((record) => el.appendChild(createStatusBoardCard(record)));
  });
  const strip = doctorEl('status-board-strip');
  if (strip) {
    strip.innerHTML = '';
    const stripRows = [...(lanes.en_attente || []), ...(lanes.no_show || []), ...(lanes.annule || [])];
    stripRows.forEach((record) => {
      strip.appendChild(createStatusBoardChip(record));
    });
    if (!stripRows.length) {
      const empty = document.createElement('p');
      empty.className = 'status-board__empty';
      empty.textContent = 'Aucune absence ni annulation aujourd’hui.';
      strip.appendChild(empty);
    }
  }
}

function createStatusBoardCard(record) {
  const card = document.createElement('li');
  card.className = 'status-board__card';
  card.innerHTML = `
    <p class="status-board__time">${escapeHtml(record.time || '—')}</p>
    <p class="status-board__name">${escapeHtml(record.name || record.patientName || 'Patient')}</p>
    <p class="status-board__motif">${escapeHtml(record.treatment || '—')}</p>
  `;
  return card;
}

function createStatusBoardChip(record) {
  const chip = document.createElement('span');
  chip.className = 'status-board__chip';
  chip.textContent = `${record.time || '—'} · ${record.name || record.patientName || 'Patient'} · ${record.status || ''}`;
  return chip;
}

function renderGapList(gaps, host) {
  if (!host) return;
  host.innerHTML = '';
  if (!gaps.length) {
    const empty = document.createElement('p');
    empty.className = 'gap-list__empty';
    empty.textContent = 'Aucun créneau libre ≥ 30 min aujourd’hui.';
    host.appendChild(empty);
    return;
  }
  gaps.forEach((gap) => {
    const row = document.createElement('li');
    row.className = 'gap-list__row';
    row.innerHTML = `
      <span>${escapeHtml(gapClockLabel(gap.start))} – ${escapeHtml(gapClockLabel(gap.end))}</span>
      <span>${Number(gap.duration_min) || 0} min</span>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-action-sm';
    btn.textContent = 'Remplir';
    btn.addEventListener('click', () => fillGapFromSlot(gap));
    row.appendChild(btn);
    host.appendChild(row);
  });
}

function gapClockLabel(value) {
  const text = String(value || '');
  if (/^\d{2}:\d{2}$/.test(text)) return text;
  const sliced = text.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(sliced) ? sliced : (text.slice(0, 5) || '—');
}

function gapSlotParts(gap) {
  const date = String(gap.date || '').slice(0, 10);
  const start = String(gap.start || '');
  if (/^\d{2}:\d{2}$/.test(start)) {
    return { slotDate: date, slotTime: start };
  }
  return {
    slotDate: date || start.slice(0, 10),
    slotTime: gapClockLabel(start),
  };
}

async function fillGapFromSlot(gap) {
  const { slotDate, slotTime } = gapSlotParts(gap);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !/^\d{2}:\d{2}$/.test(slotTime)) {
    window.alert('Créneau invalide.');
    return;
  }
  const candidate = lastWaitlist.find((row) => String(row.status || '').toLowerCase() === 'active')
    || lastWaitlist[0];
  if (!candidate?.id) {
    window.alert('Ajoutez d’abord un patient à la liste d’attente.');
    return;
  }
  try {
    window.DentaFlowAuth?.requireSession?.();
    const response = await fetch(CONFIG.FILL_GAP_PROXY, {
      method: 'POST',
      credentials: 'include',
      headers: getApiAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        slotDate,
        slotTime,
        candidateId: candidate.id,
      }),
    });
    assertAuthorizedResponse(response);
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || 'Fill-gap a échoué');
    }
    showDashboardToast('Créneau comblé depuis la liste d’attente.', 'success');
    await Promise.all([loadDoctorHubData(true), loadGaps(), loadWaitlistForOps(), loadPatientDirectory()]);
  } catch (err) {
    if (isUnauthorizedError(err)) return;
    console.error('[Fill-gap]', err?.message || err);
    window.alert(err?.message || 'Impossible de remplir ce créneau.');
  }
}

function initStatusBoardFilters() {
  doctorEl('status-board-urgence-filter')?.addEventListener('change', (event) => {
    renderStatusBoard(lastTodayRoster, event.target.checked);
  });
}

function initWaitlistAdmin() {
  doctorEl('waitlist-popover-export')?.addEventListener('click', (event) => {
    event.preventDefault();
    generateDoctorDailyReport();
  });
  doctorEl('waitlist-popover-fill-gap')?.addEventListener('click', async (event) => {
    event.preventDefault();
    const firstGap = lastGaps[0];
    if (!firstGap) {
      window.alert('Aucun créneau libre ≥ 30 min aujourd’hui.');
      return;
    }
    await fillGapFromSlot(firstGap);
  });
}

function generateDoctorDailyReport() {
  const Ops = window.DentaFlowBookingOps;
  if (!Ops?.downloadDailyCsv) return;
  Ops.downloadDailyCsv(lastTodayRoster, 'roster-temara.csv');
  Ops.printDailyRoster(lastTodayRoster, { title: 'Liste du jour — Cabinet Témara' });
}

function updateOverviewAppointmentCount(count) {
  const el = doctorEl('overview-appointment-count');
  if (el) el.textContent = String(count || 0);
}

const DOCTOR_OS_BOOT_SELECTORS = {
  sidebar: '.sidebar',
  triagePanels: '.status-board .status-board__lane',
  digestTargets: '.brutalist-digest-container, .brutalist-digest-container .digest-metric',
  triageRows: '.status-board__card',
};

function collectDoctorOsBootTargets() {
  return [
    doctorQuery(DOCTOR_OS_BOOT_SELECTORS.sidebar),
    ...doctorQueryAll(DOCTOR_OS_BOOT_SELECTORS.triagePanels),
    ...doctorQueryAll(DOCTOR_OS_BOOT_SELECTORS.digestTargets),
    ...doctorQueryAll(DOCTOR_OS_BOOT_SELECTORS.triageRows),
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

    const sidebar = doctorQuery(DOCTOR_OS_BOOT_SELECTORS.sidebar);
    const triagePanels = doctorQueryAll(DOCTOR_OS_BOOT_SELECTORS.triagePanels);
    const digestTargets = doctorQueryAll(DOCTOR_OS_BOOT_SELECTORS.digestTargets);
    const triageRows = doctorQueryAll(DOCTOR_OS_BOOT_SELECTORS.triageRows);
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
  if (typeof window.DentaFlowDom?.escapeHtml === 'function') {
    return window.DentaFlowDom.escapeHtml(value);
  }
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseTeamNotesResponse(payload) {
  return window.DentaFlowNotes?.parseNotesResponse?.(payload) || [];
}

function normalizeTeamNote(raw) {
  return window.DentaFlowNotes?.normalizeNote?.(raw) || null;
}

function parseTeamNoteTime(time) {
  return window.DentaFlowNotes?.parseNoteMinutes
    ? window.DentaFlowNotes.parseNoteMinutes(time)
    : 0;
}

function sortTeamNotes(notes) {
  return window.DentaFlowNotes?.sortNotes
    ? window.DentaFlowNotes.sortNotes(notes)
    : [...notes];
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
  const listEl = doctorEl('team-notes-list');
  const syncEl = doctorEl('team-notes-sync');
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
  const listEl = doctorEl('team-notes-list');
  const syncEl = doctorEl('team-notes-sync');

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
        errorMessage: 'Impossible de charger les messages — erreur de synchronisation avec la base de données.',
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
        loadPatientDirectory(),
        loadWaitlistForOps(),
        loadGaps(),
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
