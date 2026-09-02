/**
 * DentaFlow OS — shared utilities (auth, theme, DOM helpers, motion).
 * Loaded before auth.js and doctor.js. Self-contained; no doctor/app refs.
 */
'use strict';

/* ── Auth & API utilities (from dashboard_app.js:1-42) ── */
/* --- SECURITY — auth gate handled by auth.js (httpOnly cookie; no Bearer header) --- */
function getApiAuthHeaders(extra = {}) {
  const apiHeaders = typeof window.DentaFlowAuth?.buildApiHeaders === 'function'
    ? window.DentaFlowAuth.buildApiHeaders()
    : { Accept: 'application/json' };

  return {
    ...apiHeaders,
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

async function apiFetch(url, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const extraHeaders = opts.headers || {};
  const response = await fetch(url, {
    ...opts,
    credentials: opts.credentials != null ? opts.credentials : 'include',
    headers: getApiAuthHeaders(extraHeaders),
  });
  return assertAuthorizedResponse(response);
}

const authorizedFetch = apiFetch;
const requestWithAuth = apiFetch;

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

/* ── DOM id helper (from dashboard_app.js:118-120) ── */
function __domById(id) {
  return document['getElementById'](id);
}

/* ── Dashboard unlock (from dashboard_app.js:44-70; doctorEl → __domById) ── */
function unlockDashboard({ skipDashboardFetch = false } = {}) {
  if (
    typeof window.DentaFlowAuth?.isAuthenticated === 'function' &&
    !window.DentaFlowAuth.isAuthenticated()
  ) {
    void window.DentaFlowAuth.logout?.();
    return;
  }

  const overlay = __domById('login-overlay');
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
window.apiFetch = apiFetch;
window.authorizedFetch = authorizedFetch;
window.requestWithAuth = requestWithAuth;
window.assertAuthorizedResponse = assertAuthorizedResponse;

/* ── Theme & preferences (from dashboard_app.js:154-215) ── */
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
  ROSTER_ENDPOINT:      '/api/roster',
  DIGEST_DAILY_GOAL_MAD: 6000,
  DIGEST_REVENUE_PER_PATIENT_MAD: 400,
  CURRENCY_LOCALE:      'fr-MA',
  CURRENCY:             'MAD',
};

const bootDailyGoal = loadPersistedDailyGoal();
if (bootDailyGoal != null) {
  CONFIG.DAILY_GOAL_MAD = bootDailyGoal;
}
/* ── Form submit lock (from dashboard_app.js:217-231; + isSubmitLocked / unlockSubmitButton) ── */
const SUBMIT_LOCK_MS       = 5000;

function lockSubmitButton(btn, processingLabel = 'Traitement...') {
  const defaultLabel = btn.textContent;
  const startedAt = Date.now();
  btn.disabled = true;
  btn.dataset.submitLocked = '1';
  btn.textContent = processingLabel;
  return {
    defaultLabel,
    startedAt,
    minRemaining() {
      return Math.max(0, SUBMIT_LOCK_MS - (Date.now() - startedAt));
    },
  };
}

function isSubmitLocked(btn) {
  return Boolean(btn && btn.disabled && btn.dataset.submitLocked === '1');
}

function unlockSubmitButton(btn, lockState) {
  if (!btn) return;
  const remaining = lockState && typeof lockState.minRemaining === 'function'
    ? lockState.minRemaining()
    : 0;
  const finish = () => {
    btn.disabled = false;
    delete btn.dataset.submitLocked;
    if (lockState && lockState.defaultLabel != null) {
      btn.textContent = lockState.defaultLabel;
    }
  };
  if (remaining > 0) {
    setTimeout(finish, remaining);
  } else {
    finish();
  }
}


/* ── escapeHtml (from dashboard_app.js:3812-3819) ── */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Generic UI helpers (from dashboard_app.js:367-469) ── */
function buildStatusPill(label, modifierClass = '') {
  const safeLabel = escapeHtml(label || '—');
  const classes = ['status-pill', modifierClass].filter(Boolean).join(' ');
  return `<span class="${classes}"><span class="status-pill__dot" aria-hidden="true"></span>${safeLabel}</span>`;
}

function formatInitials(fullName) {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  return parts
    .slice(0, 2)
    .map((part) => part.replace(/\./g, '')[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2) || '??';
}

/** Alias kept for doctor.js call sites */
function extractPatientInitials(fullName) {
  return formatInitials(fullName);
}

function normalizeLabel(label) {
  return (label ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function getMatteChipModifier(label) {
  const n = normalizeLabel(label);
  if (n.includes('urgence')) return 'urgence';
  if (n.includes('confirm')) return 'confirmé';
  if (n.includes('annul') || n.includes('no-show')) return 'annulé';
  if (n.includes('attente') || n.includes('soin')) return 'attente';
  if (n.includes('termin')) return 'confirmé';
  return 'attente';
}

function buildStatusChip(label, modifierClass = '') {
  const chip = document.createElement('span');
  const mod = modifierClass || getMatteChipModifier(label);
  chip.className = ['matte-chip', mod ? `matte-chip--${mod}` : ''].filter(Boolean).join(' ');
  chip.textContent = label || '—';
  return chip;
}

function createMatteChip(label) {
  return buildStatusChip(label);
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
  avatar.textContent = formatInitials(name);
  return avatar;
}

function buildPatientIdentity(name) {
  const wrap = document.createElement('div');
  wrap.className = 'patient-identity';
  wrap.appendChild(createPatientAvatar(name));
  const nameEl = document.createElement('span');
  nameEl.className = 'patient-identity__name';
  nameEl.textContent = name || '';
  wrap.appendChild(nameEl);
  return wrap;
}

/** Alias kept for doctor.js call sites */
function createPatientIdentity(name) {
  return buildPatientIdentity(name);
}

function getWaitlistPriorityLabel(appt) {
  if (appt.statusLabel) return appt.statusLabel;
  const treatment = String(appt.treatment ?? appt.priorite ?? '').toLowerCase();
  if (appt.tagClass === 'urgence' || treatment === 'haute') return 'Urgence';
  return 'En attente';
}

function buildWaitlistRow(appt) {
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

/** Alias kept for doctor.js call sites */
function createWaitlistTableRow(appt) {
  return buildWaitlistRow(appt);
}

/* ── Theme apply with typeof guards (from dashboard_app.js:899-912) ── */
function loadPersistedTheme() {
  return resolveInitialTheme();
}

function applyTheme(theme) {
  const resolved = theme === 'pearl-clinic' || theme === 'light' ? 'pearl-clinic' : 'oak-lounge';

  document.documentElement.setAttribute('data-theme', resolved);
  if (typeof volatileSettings !== 'undefined' && volatileSettings) {
    volatileSettings.theme = resolved;
  }
  if (typeof updateThemeSwitcherUI === 'function') {
    updateThemeSwitcherUI(resolved);
  }
  if (typeof lastChartData !== 'undefined' && lastChartData && typeof renderCharts === 'function') {
    renderCharts(lastChartData);
  }
  if (typeof lastKpiPayload !== 'undefined' && lastKpiPayload && typeof initOperationalCharts === 'function') {
    initOperationalCharts(lastKpiPayload);
  }
}

/* ── Motion stack (from dashboard_app.js:2877-2901) ── */
/** @type {import('lenis').default | null} */
let lenisInstance = null;

/**
 * Lenis smooth scroll synced to GSAP ticker.
 * Call once on doctor dashboard boot.
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


/* ── Merged from dom-safe.js ── */

/**
 * DentaFlow OS — safe DOM builders (mitigates XSS from dynamic roster/CRM data).
 */
(function () {
  'use strict';

  function text(value) {
    return document.createTextNode(String(value ?? ''));
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs && typeof attrs === 'object') {
      Object.entries(attrs).forEach(([key, value]) => {
        if (value == null) return;
        node.setAttribute(key, String(value));
      });
    }
    return node;
  }

  function setTextContent(node, value) {
    clear(node);
    node.appendChild(text(value));
  }

  function setStatusPill(node, label) {
    clear(node);
    node.appendChild(el('span', 'status-pill__dot', { 'aria-hidden': 'true' }));
    node.appendChild(text(label || '—'));
  }

  function appendParagraph(parent, className, message) {
    const p = el('p', className);
    p.appendChild(text(message));
    parent.appendChild(p);
    return p;
  }

  function createStatusPill(label, modifierClass = '') {
    const pill = el('span', ['status-pill', modifierClass].filter(Boolean).join(' '));
    setStatusPill(pill, label);
    return pill;
  }

  function lucideIcon(name, className = '') {
    const cls = className ? ` class="${className}"` : '';
    return `<i data-lucide="${name}"${cls} aria-hidden="true"></i>`;
  }

  function refreshLucideIcons(root) {
    if (typeof lucide === 'undefined' || typeof lucide.createIcons !== 'function') return;
    const options = { attrs: { 'stroke-width': 2 } };
    if (root && typeof root.querySelectorAll === 'function') {
      options.root = root;
    }
    try {
      lucide.createIcons(options);
    } catch (error) {
      // Never let a missing icon name crash dashboard boot.
      console.warn('[Lucide] createIcons failed:', error?.message || error);
    }
  }

  window.DentaFlowDom = {
    text,
    clear,
    el,
    setTextContent,
    setStatusPill,
    appendParagraph,
    createStatusPill,
  };
  window.refreshLucideIcons = refreshLucideIcons;
  window.lucideIcon = lucideIcon;
})();


/* ── Merged from confirm-dialog.js ── */

/**
 * DentaFlow OS — confirmation dialog for destructive actions.
 * Usage: const ok = await DentaFlowConfirm.confirmAction(message);
 * Optional callback: DentaFlowConfirm.confirmAction(message, onConfirm);
 */
(function (global) {
  'use strict';

  var TITLE = 'Confirmer l\'action';
  var overlayEl = null;
  var dialogEl = null;
  var messageEl = null;
  var cancelBtn = null;
  var confirmBtn = null;
  var lastFocus = null;
  var activeResolver = null;

  function ensureDialog() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'df-confirm-overlay';
    overlayEl.className = 'df-confirm-overlay';
    overlayEl.hidden = true;

    dialogEl = document.createElement('div');
    dialogEl.className = 'df-confirm-dialog';
    dialogEl.setAttribute('role', 'dialog');
    dialogEl.setAttribute('aria-modal', 'true');
    dialogEl.setAttribute('aria-labelledby', 'df-confirm-title');
    dialogEl.setAttribute('aria-describedby', 'df-confirm-message');

    var titleEl = document.createElement('h2');
    titleEl.id = 'df-confirm-title';
    titleEl.className = 'df-confirm-title';
    titleEl.textContent = TITLE;

    messageEl = document.createElement('p');
    messageEl.id = 'df-confirm-message';
    messageEl.className = 'df-confirm-message';

    var actions = document.createElement('div');
    actions.className = 'df-confirm-actions';

    cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'df-confirm-btn df-confirm-btn--cancel';
    cancelBtn.textContent = 'Annuler';

    confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'df-confirm-btn df-confirm-btn--confirm';
    confirmBtn.textContent = 'Confirmer';

    actions.append(cancelBtn, confirmBtn);
    dialogEl.append(titleEl, messageEl, actions);
    overlayEl.appendChild(dialogEl);
    document.body.appendChild(overlayEl);

    overlayEl.addEventListener('click', function (event) {
      if (event.target === overlayEl) closeDialog(false);
    });
    cancelBtn.addEventListener('click', function () { closeDialog(false); });
    confirmBtn.addEventListener('click', function () { closeDialog(true); });
    overlayEl.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(event) {
    if (overlayEl.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog(false);
      return;
    }
    if (event.key !== 'Tab') return;
    var focusables = [cancelBtn, confirmBtn];
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function closeDialog(confirmed) {
    if (!overlayEl || overlayEl.hidden) return;
    overlayEl.hidden = true;
    overlayEl.classList.remove('is-open');
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
    }
    lastFocus = null;
    var resolve = activeResolver;
    activeResolver = null;
    if (typeof resolve === 'function') resolve(Boolean(confirmed));
  }

  function confirmAction(message, onConfirm) {
    ensureDialog();
    if (activeResolver) closeDialog(false);

    return new Promise(function (resolve) {
      activeResolver = function (ok) {
        if (ok && typeof onConfirm === 'function') onConfirm();
        resolve(ok);
      };
      lastFocus = document.activeElement;
      messageEl.textContent = String(message || '');
      overlayEl.hidden = false;
      overlayEl.classList.add('is-open');
      confirmBtn.focus();
    });
  }

  global.DentaFlowConfirm = {
    confirmAction: confirmAction,
  };
})(window);
