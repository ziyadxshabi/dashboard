/**
 * Assistant shell — Postgres roster, waitlist, and team notes.
 * Clinique Dentaire Témara Mall · DentaFlow OS
 */

(function () {
  'use strict';

const CONFIG = {
  ROSTER_PROXY: '/api/roster',
  UPDATE_STATUS_PROXY: '/api/update-status',
  FILL_GAP_PROXY: '/api/fill-gap',
  TEAM_NOTES_PROXY: '/api/team-notes',
  ENDPOINTS: {
    GET_ROSTER: '/api/roster',
    UPDATE_STATUS: '/api/update-status',
    GET_NOTES: '/api/team-notes',
    POST_NOTE: '/api/team-notes',
    WAITLIST_ADD: '/api/waitlist',
    WAITLIST_GET: '/api/waitlist',
    BULK_SMS: '/api/bulk-sms',
  },
};

const BULK_PENDING_STATUS = 'En attente';

const STATUS_OPTIONS = [
  'Confirmé',
  'En salle d\'attente',
  'En soin',
  'Terminé',
  'No-show',
  'Annulé',
];

const CANCEL_REASON_LABELS = {
  oublie: 'Oubli',
  cout: 'Coût',
  reprogramme: 'Reprogrammé',
  autre: 'Autre',
};

function bookingKindOf(record) {
  return String(record?.booking_kind || record?.bookingKind || 'visit') || 'visit';
}

function isVisitBooking(record) {
  return bookingKindOf(record) === 'visit';
}

function isHoldBooking(record) {
  return bookingKindOf(record) === 'emergency_hold';
}

const VIEW_MAP = {
  overview: 'view-overview',
  calendar: 'view-calendar',
  waitlist: 'view-waitlist',
  crm: 'view-crm',
  settings: 'view-settings',
};

const MOBILE_DOCK_NAV = new Set(['overview', 'planning', 'transmission', 'waitlist', 'settings']);
const MOBILE_OVERVIEW_SECTIONS = new Set(['overview', 'planning', 'transmission']);
const MOBILE_FULL_VIEW_TABS = new Set(['waitlist', 'settings']);

function isFetchAborted(error) {
  if (!error) return false;
  const name = String(error.name || error.constructor?.name || '');
  const message = String(error.message || error);
  return name === 'AbortError' || /aborted/i.test(message);
}

const lucideIcon = (name, className = '') => window.lucideIcon?.(name, className)
  ?? `<i data-lucide="${name}"${className ? ` class="${className}"` : ''} aria-hidden="true"></i>`;

const NOSHOW_SVG = lucideIcon('alert-triangle', 'icon-sm');
const TREND_UP_SVG = lucideIcon('trending-up', 'icon-sm');
const TREND_DOWN_SVG = lucideIcon('trending-down', 'icon-sm');
const SYSTEM_NOTE_SVG = lucideIcon('bot', 'icon-sm');
const PIN_BADGE_SVG = lucideIcon('pin', 'icon-sm');

const PLANNING_UPSTREAM_ERROR_MESSAGE =
  'Erreur de connexion au serveur (503). Veuillez rafraîchir la page ou contacter le support.';
const PLANNING_SERVER_ERROR_MESSAGE =
  'Erreur interne du serveur (HTTP 500). Veuillez rafraîchir la page ou contacter le support.';

  const RowUI = window.DentaFlowRowUI || {};

  function getMatteChipModifier(label) {
    return RowUI.getMatteChipModifier ? RowUI.getMatteChipModifier(label) : 'attente';
  }

  function createStatusDot(label) {
    return RowUI.createStatusDot(label);
  }

  function createPriorityIndicator(label) {
    return RowUI.createPriorityIndicator(label);
  }

  function createMatteChip(label) {
    return RowUI.createMatteChip(label);
  }

  function createPatientAvatar(name) {
    return RowUI.createPatientAvatar(name);
  }

  function createPatientIdentity(name, options) {
    return RowUI.createPatientIdentity(name, options);
  }

  function getWaitlistPriorityLabel(appt) {
    return RowUI.getWaitlistPriorityLabel(appt);
  }

  function isWaitlistUrgent(appt) {
    return RowUI.isWaitlistUrgent(appt);
  }

  function createCopyableSpan(value, displayLabel) {
    return RowUI.createCopyableSpan(value, displayLabel);
  }

  function createWaitlistTableRow(appt) {
    return RowUI.createWaitlistTableRow(appt);
  }

  function createEmptyState(options) {
    return RowUI.createEmptyState(options);
  }

  function mountEmptyState(hostId, options) {
    return RowUI.mountEmptyState(hostId, options);
  }

  function clearEmptyState(hostId) {
    return RowUI.clearEmptyState(hostId);
  }

  function initEmptyStatePulse(emptyStateEl) {
    return RowUI.initEmptyStatePulse?.(emptyStateEl);
  }

  function extractInitials(fullName) {
    return RowUI.extractInitials ? RowUI.extractInitials(fullName) : '??';
  }

  const EMPTY_STATE_DEFAULT_MESSAGE = RowUI.EMPTY_STATE_DEFAULT_MESSAGE
    || 'Aucun rendez-vous pour aujourd\'hui.';
  const EMPTY_STATE_SVG_CALENDAR = RowUI.EMPTY_STATE_SVG_CALENDAR || lucideIcon('calendar-clock', 'icon-lg');
  const EMPTY_STATE_SVG_INBOX = RowUI.EMPTY_STATE_SVG_INBOX || lucideIcon('inbox', 'icon-lg');

function normalizePulseStatus(status) {
  return String(status || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\u2019/g, "'");
}

const PULSE_SEEN_STATUSES = new Set(
  ['En salle d\'attente', 'En soin', 'Terminé'].map(normalizePulseStatus)
);
const PULSE_CANCELLED_STATUSES = new Set(
  ['No-show', 'Annulé', 'noshow'].map(normalizePulseStatus)
);

function isPulseSeenStatus(status) {
  const key = normalizePulseStatus(status);
  if (PULSE_SEEN_STATUSES.has(key)) return true;
  return key.includes('salle') && key.includes('attente');
}

function isPulseCancelledStatus(status) {
  const key = normalizePulseStatus(status);
  if (PULSE_CANCELLED_STATUSES.has(key)) return true;
  return key.includes('annul') || key.includes('no-show') || key === 'noshow';
}

function createEmptyOperationalPulse() {
  return {
    planned: 0,
    seen: 0,
    inChair: 0,
    inWaiting: 0,
    holes: 0,
  };
}

function isPulseInChairStatus(status) {
  return normalizePulseStatus(status) === 'en soin';
}

function isPulseWaitingRoomStatus(status) {
  const key = normalizePulseStatus(status);
  return key.includes('salle') && key.includes('attente');
}

function computeOperationalPulse(records) {
  const pulse = createEmptyOperationalPulse();
  const rows = Array.isArray(records) ? records.filter(Boolean) : [];
  for (const record of rows) {
    if (!isVisitBooking(record)) continue;
    if (isPulseCancelledStatus(record.status)) {
      pulse.holes += 1;
      continue;
    }
    pulse.planned += 1;
    if (isPulseSeenStatus(record.status)) pulse.seen += 1;
    if (isPulseInChairStatus(record.status)) pulse.inChair += 1;
    if (isPulseWaitingRoomStatus(record.status)) pulse.inWaiting += 1;
  }
  return pulse;
}

function parseStartsAt(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isLateOnScheduledTime(record, now = new Date()) {
  const key = normalizePulseStatus(record?.status);
  if (key !== 'confirme' && key !== 'en attente') return false;
  const start = parseStartsAt(record.starts_at || record.startTime || record.rawDate);
  if (!start) return false;
  return start.getTime() < now.getTime();
}

function boardColumnForStatus(status) {
  const key = normalizePulseStatus(status);
  if (key === 'termine') return 'done';
  if (key === 'en soin') return 'care';
  if (isPulseWaitingRoomStatus(status)) return 'waiting';
  if (key === 'confirme' || key === 'en attente') return 'incoming';
  return null;
}

let handoffNotes = [];

  let toastTimer = null;
  let rosterData = [];
  let allRosterRecords = [];
  let crmPatientsById = {};
  let crmUnpaidOnly = false;
  let waitlistUrgentOnly = false;
  let waitlistEntries = [];
  let selectedPatientIds = [];
  let activeView = 'overview';
  let activeMobileTab = 'overview';
  let osBootSequencePlayed = false;

  function assistantRoot() {
    return document.getElementById('assistant-mount')
      || document.getElementById('assistant-shell')
      || document.querySelector('.assistant-app-root')
      || document;
  }

  function $(id) {
    const root = assistantRoot();
    if (root && root !== document) {
      const scoped = root.querySelector('[id="' + String(id).replace(/"/g, '\\"') + '"]');
      if (scoped) return scoped;
    }
    return document.getElementById(id);
  }

  function showSkeleton(section) {
    const sk = $(`${section}-skeleton`);
    const content = $(`${section}-content`);
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
    const sk = $(`${section}-skeleton`);
    const content = $(`${section}-content`);
    if (sk) {
      sk.hidden = true;
      sk.style.display = 'none';
    }
    if (content) {
      content.hidden = false;
      content.style.display = '';
    }
  }

  function assistantQuery(selector) {
    return assistantRoot().querySelector(selector);
  }

  function assistantQueryAll(selector) {
    return assistantRoot().querySelectorAll(selector);
  }

  function apiHeaders(extra = {}) {
    const authHeaders = typeof window.DentaFlowAuth?.getAuthHeaders === 'function'
      ? window.DentaFlowAuth.getAuthHeaders()
      : { Accept: 'application/json' };

    return {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...extra,
    };
  }

  /** GET roster — Bearer auth; no Content-Type to avoid unnecessary CORS preflight */
  function rosterFetchHeaders() {
    const authHeaders = typeof window.DentaFlowAuth?.getAuthHeaders === 'function'
      ? window.DentaFlowAuth.getAuthHeaders()
      : { Accept: 'application/json' };

    return {
      ...authHeaders,
    };
  }

  function assertAuthorizedResponse(response) {
    if (typeof window.DentaFlowAuth?.assertAuthorizedResponse === 'function') {
      return window.DentaFlowAuth.assertAuthorizedResponse(response);
    }
    if (response?.status === 401) {
      void window.DentaFlowAuth?.logout?.();
      const err = new Error('Session expirée. Reconnectez-vous.');
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

  function setHeaderDate() {
    const el = $('assistant-date');
    if (!el) return;
    el.textContent = new Date().toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  function parseHandoffTime(time) {
    return window.DentaFlowNotes?.parseNoteMinutes?.(time)
      ?? String(time || '00:00').split(':').map(Number).reduce((h, m, i) => (i === 0 ? (h || 0) * 60 : h + (m || 0)), 0);
  }

  function sortHandoffNotes(notes) {
    if (typeof window.DentaFlowNotes?.sortNotes === 'function') {
      return window.DentaFlowNotes.sortNotes(notes);
    }
    return [...notes].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return parseHandoffTime(b.time) - parseHandoffTime(a.time);
    });
  }

  function getHandoffCategorySlug(category) {
    const normalized = String(category || 'Info').toLowerCase();
    if (normalized === 'urgent') return 'urgent';
    if (normalized === 'planning') return 'planning';
    return 'info';
  }

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

  function createReadReceiptsElement(readBy) {
    const avatars = Array.isArray(readBy)
      ? readBy.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    if (!avatars.length) return null;

    const div = document.createElement('div');
    div.className = 'handoff-note__receipts';
    div.setAttribute('aria-label', `Lu par ${avatars.join(', ')}`);
    avatars.forEach((initials) => {
      const span = document.createElement('span');
      span.className = 'handoff-note__avatar';
      span.title = initials;
      span.textContent = initials;
      div.appendChild(span);
    });
    return div;
  }

  function createHandoffNoteElement(note, options = {}) {
    const isSystem = note.type === 'system';
    const categorySlug = getHandoffCategorySlug(note.category);
    const enterClass = options.isNew ? ' is-entering' : '';

    const article = document.createElement('article');
    article.className = `handoff-note handoff-note--${categorySlug}${note.pinned ? ' handoff-note--pinned' : ''}${isSystem ? ' handoff-note--system' : ''}${enterClass}`;
    article.dataset.noteId = String(note.id);
    article.setAttribute('role', 'article');

    const dot = document.createElement('span');
    dot.className = `handoff-note__dot handoff-note__dot--${categorySlug}`;
    dot.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'handoff-note__body';

    const meta = document.createElement('div');
    meta.className = 'handoff-note__meta';

    const categorySpan = document.createElement('span');
    categorySpan.className = `handoff-note__category handoff-note__category--${categorySlug}`;
    categorySpan.textContent = note.category || 'Info';
    meta.appendChild(categorySpan);

    if (isSystem) {
      const systemIcon = document.createElement('span');
      systemIcon.className = 'handoff-note__system-icon';
      systemIcon.title = 'Événement système';
      systemIcon.setAttribute('aria-label', 'Événement système');
      systemIcon.innerHTML = SYSTEM_NOTE_SVG;
      meta.appendChild(systemIcon);
    } else if (note.author) {
      const authorSpan = document.createElement('span');
      authorSpan.className = 'handoff-note__author';
      authorSpan.textContent = note.author;
      meta.appendChild(authorSpan);
    }

    if (note.time) {
      const timeEl = document.createElement('time');
      timeEl.className = 'handoff-note__time';
      timeEl.dateTime = note.time;
      timeEl.textContent = note.time;
      meta.appendChild(timeEl);
    }

    if (note.pinned) {
      const pinBadge = document.createElement('span');
      pinBadge.className = 'handoff-note__pin-badge';
      pinBadge.setAttribute('aria-label', 'Note épinglée');
      pinBadge.innerHTML = PIN_BADGE_SVG;
      pinBadge.appendChild(document.createTextNode(' Épinglé'));
      meta.appendChild(pinBadge);
    }

    if (note.patientName || note.patient_name) {
      const patientSpan = document.createElement('span');
      patientSpan.className = 'handoff-note__patient';
      patientSpan.textContent = note.patientName || note.patient_name;
      meta.appendChild(patientSpan);
    }

    const textP = document.createElement('p');
    textP.className = 'handoff-note__text';
    textP.textContent = note.text || '';

    body.append(meta, textP);
    article.append(dot, body);

    const receipts = createReadReceiptsElement(note.readBy);
    if (receipts) article.appendChild(receipts);

    window.refreshLucideIcons?.(article);
    return article;
  }

  function renderHandoffBoard(options = {}) {
    const feed = $('handoff-feed');
    if (!feed) return;

    const sorted = sortHandoffNotes(handoffNotes);
    const newestId = options.highlightId ?? sorted[0]?.id;

    if (options.animate) {
      feed.classList.add('is-refreshing');
    }

    window.requestAnimationFrame(() => {
      feed.replaceChildren();
      if (options.errorMessage) {
        window.DentaFlowDom?.appendParagraph(feed, 'handoff-feed__empty', options.errorMessage);
      } else if (!sorted.length) {
        window.DentaFlowDom?.appendParagraph(
          feed,
          'handoff-feed__empty',
          'Aucune transmission pour le moment. Ajoutez une note d\'équipe ci-dessus.'
        );
      } else {
        const fragment = document.createDocumentFragment();
        sorted.forEach((note) => {
          fragment.appendChild(createHandoffNoteElement(note, {
            isNew: note.id === newestId && options.animate,
          }));
        });
        feed.appendChild(fragment);
      }

      feed.classList.remove('is-refreshing');
      window.refreshLucideIcons?.(feed);
    });
  }

  function parseHandoffResponse(payload) {
    if (typeof window.DentaFlowNotes?.parseNotesResponse === 'function') {
      return window.DentaFlowNotes.parseNotesResponse(payload);
    }
    if (payload == null) return [];
    if (Array.isArray(payload)) return payload;
    return [];
  }

  function normalizeHandoffRecord(raw) {
    if (typeof window.DentaFlowNotes?.normalizeNote === 'function') {
      return window.DentaFlowNotes.normalizeNote(raw);
    }
    return null;
  }

  async function loadHandoffNotes() {
    const feed = $('handoff-feed');
    if (feed && !handoffNotes.length) {
      feed.replaceChildren();
      window.DentaFlowDom?.appendParagraph(feed, 'handoff-feed__empty', 'Chargement des transmissions…');
    }

    try {
      const response = await fetch(
        CONFIG.TEAM_NOTES_PROXY,
        { method: 'GET', credentials: 'include', headers: rosterFetchHeaders() }
      );

      const rawText = await response.text();
      let payload;
      try {
        payload = rawText.trim() ? JSON.parse(rawText) : [];
      } catch {
        throw new Error(`Réponse non-JSON: ${rawText.slice(0, 120)}`);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 120)}`);
      }

      const rawRows = parseHandoffResponse(payload);
      handoffNotes = rawRows.map(normalizeHandoffRecord).filter(Boolean);
      renderHandoffBoard();
    } catch (error) {
      if (isFetchAborted(error)) {
        console.warn('[Sync] Fetch safely aborted by lifecycle controller. Suppressing UI error injection.');
        if (handoffNotes.length) {
          renderHandoffBoard();
        }
        return;
      }
      console.error('[Handoff] Load failed:', error?.message || error);
      handoffNotes = [];
      renderHandoffBoard({
        errorMessage: 'Impossible de charger les transmissions. Erreur de synchronisation avec la base.',
      });
    }
  }

  function renderOperationalPulse(pulseData = createEmptyOperationalPulse()) {
    return safeRender('renderOperationalPulse', () => {
    const grid = $('assistant-pulse-grid');
    if (!grid) return;

    const data = pulseData ?? createEmptyOperationalPulse();
    grid.replaceChildren();

    const cards = [
      {
        label: 'Prévus',
        value: String(data.planned),
        meta: `${data.seen} vus`,
        tip: 'Rendez-vous non annulés aujourd\'hui',
      },
      {
        label: 'Au fauteuil',
        value: String(data.inChair),
        meta: 'En soin',
        tip: 'Patients actuellement en soin',
      },
      {
        label: 'En salle',
        value: String(data.inWaiting),
        meta: "Salle d'attente",
        tip: "Patients en salle d'attente",
      },
      {
        label: 'Créneaux libres',
        value: String(data.holes),
        meta: 'Annulé ou absent',
        tip: 'Créneaux libérés aujourd\'hui',
      },
    ];

    const fragment = document.createDocumentFragment();
    cards.forEach((card) => {
      const article = document.createElement('article');
      article.className = 'pulse-card pulse-card--row';
      const head = document.createElement('div');
      head.className = 'pulse-card__head';
      const label = document.createElement('p');
      label.className = 'pulse-card__label kinetic-label';
      label.dataset.tooltip = card.tip;
      label.textContent = card.label;
      head.appendChild(label);
      const value = document.createElement('p');
      value.className = 'pulse-card__value kinetic-value';
      value.textContent = card.value;
      const meta = document.createElement('p');
      meta.className = 'pulse-card__meta';
      meta.textContent = card.meta;
      article.append(head, value, meta);
      fragment.appendChild(article);
    });
    grid.appendChild(fragment);
    });
  }

  function formatRosterClock(record) {
    const start = parseStartsAt(record?.starts_at || record?.startTime || record?.rawDate);
    if (start) {
      return start.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Africa/Casablanca',
      });
    }
    return record?.time || '';
  }

  function pickCancelReason() {
    return new Promise((resolve) => {
      const sheet = $('cancel-reason-sheet');
      if (!sheet) {
        resolve('autre');
        return;
      }
      sheet.hidden = false;
      const onClick = (event) => {
        const dismiss = event.target.closest('[data-cancel-dismiss]');
        const btn = event.target.closest('[data-cancel-reason]');
        if (!dismiss && !btn) return;
        sheet.hidden = true;
        sheet.removeEventListener('click', onClick);
        resolve(btn ? btn.getAttribute('data-cancel-reason') : null);
      };
      sheet.addEventListener('click', onClick);
    });
  }

  async function postRecallForRecord(record) {
    try {
      const response = await fetch(`${CONFIG.ROSTER_PROXY}?action=recall`, {
        method: 'POST',
        credentials: 'include',
        headers: apiHeaders(),
        body: JSON.stringify({
          bookingId: record.id,
          patientName: record.name || record.patient_name,
          patientPhone: record.phone || record.patient_phone,
          treatmentName: record.treatment || record.treatment_name,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      showToast('Rappel 6 mois enregistré. À placer, pas un SMS.', 'success');
      await loadRecallStrip();
    } catch {
      showToast('Impossible d\'enregistrer le rappel.', 'error');
    }
  }

  function renderHoldStrip(records) {
    const section = $('hold-strip');
    const list = $('hold-list');
    if (!section || !list) return;
    const holds = (Array.isArray(records) ? records : []).filter(isHoldBooking);
    section.hidden = holds.length === 0;
    list.replaceChildren();
    holds.forEach((record) => {
      const chip = document.createElement('div');
      chip.className = 'hold-chip';
      chip.setAttribute('role', 'listitem');
      const when = document.createElement('span');
      when.textContent = formatRosterClock(record);
      const label = document.createElement('span');
      label.textContent = record.name || 'Urgence réservée';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Relâcher';
      btn.addEventListener('click', () => void releaseEmergencyHold(record.id));
      chip.append(when, label, btn);
      list.appendChild(chip);
    });
  }

  async function loadRecallStrip() {
    const section = $('recall-strip');
    const list = $('recall-list');
    if (!section || !list) return;
    try {
      const response = await fetch(`${CONFIG.ROSTER_PROXY}?recalls=open`, {
        method: 'GET',
        credentials: 'include',
        headers: rosterFetchHeaders(),
        cache: 'no-store',
      });
      assertAuthorizedResponse(response);
      const payload = await response.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      section.hidden = rows.length === 0;
      list.replaceChildren();
      rows.forEach((row) => {
        const chip = document.createElement('div');
        chip.className = 'recall-chip';
        chip.setAttribute('role', 'listitem');
        const due = row.due_on ? String(row.due_on).slice(0, 10) : '';
        chip.textContent = [due, row.patient_name, row.treatment_name, row.patient_phone]
          .filter(Boolean)
          .join(' · ');
        list.appendChild(chip);
      });
    } catch (err) {
      if (isUnauthorizedError(err)) return;
      section.hidden = true;
    }
  }

  async function releaseEmergencyHold(holdId) {
    const name = $('floor-book-name')?.value.trim();
    const phone = $('floor-book-phone')?.value.trim();
    const treatment = $('floor-book-treatment')?.value.trim();
    if (!name || !phone || !treatment) {
      showToast('Remplissez Nouveau RDV (nom, téléphone, soin) puis Relâcher.', 'error');
      return;
    }
    try {
      const response = await fetch(`${CONFIG.ROSTER_PROXY}?action=release`, {
        method: 'POST',
        credentials: 'include',
        headers: apiHeaders(),
        body: JSON.stringify({ id: holdId, patientName: name, phone, treatment }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && payload?.code === 'DUPLICATE_HINT') {
        const ok = await askConfirm('Même téléphone ou même nom sur 90 jours. Poser quand même ?');
        if (!ok) return;
        const retry = await fetch(`${CONFIG.ROSTER_PROXY}?action=release`, {
          method: 'POST',
          credentials: 'include',
          headers: apiHeaders(),
          body: JSON.stringify({
            id: holdId,
            patientName: name,
            phone,
            treatment,
            confirmDuplicate: true,
          }),
        });
        const retryPayload = await retry.json().catch(() => ({}));
        if (!retry.ok || retryPayload?.ok === false) throw new Error(retryPayload?.error || 'release');
      } else if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      showToast('Urgence relâchée.', 'success');
      loadPlanning();
    } catch {
      showToast('Impossible de relâcher l\'urgence.', 'error');
    }
  }

  async function postRosterBooking(body) {
    const response = await fetch(CONFIG.ROSTER_PROXY, {
      method: 'POST',
      credentials: 'include',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 409 && payload?.code === 'DUPLICATE_HINT') {
      const ok = await askConfirm('Même téléphone ou même nom sur 90 jours (pas un dossier). Poser quand même ?');
      if (!ok) return null;
      return postRosterBooking({ ...body, confirmDuplicate: true });
    }
    if (response.status === 409 && payload?.code === 'OVERLAP') {
      showToast(payload.error || 'Créneau déjà pris.', 'error');
      return null;
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  function selectedFloorSlotIso() {
    const active = $('floor-book-slots')?.querySelector('.floor-composer__slot.is-active');
    return active?.dataset.startsAt || '';
  }

  async function loadTreatmentCatalog() {
    const hidden = $('floor-book-treatment');
    const list = $('floor-book-treatment-list');
    const slots = $('floor-book-slots');
    const durationEl = $('floor-composer-duration');
    if (!hidden || !list) return;

    const syncDuration = (value) => {
      const selected = list.querySelector('.ghost-select__option.is-selected')
        || list.querySelector(`.ghost-select__option[data-value="${CSS.escape(String(value || ''))}"]`);
      const mins = selected?.dataset?.duration;
      if (durationEl) durationEl.textContent = mins ? `${mins} min` : 'Durée selon le soin';
    };

    try {
      const response = await fetch(`${CONFIG.ROSTER_PROXY}?catalog=1`, {
        method: 'GET',
        credentials: 'include',
        headers: rosterFetchHeaders(),
        cache: 'no-store',
      });
      assertAuthorizedResponse(response);
      const payload = await response.json();
      const treatments = payload?.data?.treatments || [];
      const previous = hidden.value;
      list.replaceChildren();
      const blank = document.createElement('li');
      blank.className = 'ghost-select__option';
      blank.setAttribute('role', 'option');
      blank.dataset.value = '';
      blank.textContent = 'Choisir un soin';
      list.appendChild(blank);
      treatments.forEach((item) => {
        const option = document.createElement('li');
        option.className = 'ghost-select__option';
        option.setAttribute('role', 'option');
        option.dataset.value = item.name;
        option.dataset.duration = String(item.duration_min);
        option.dataset.label = `${item.name} · ${item.duration_min} min`;
        option.textContent = `${item.name} · ${item.duration_min} min`;
        list.appendChild(option);
      });
      const keepPrevious = previous && treatments.some((item) => item.name === previous);
      window.DentaFlowSelect?.init?.({
        rootId: 'floor-book-treatment-root',
        hiddenId: 'floor-book-treatment',
        triggerId: 'floor-book-treatment-trigger',
        listId: 'floor-book-treatment-list',
        labelId: 'floor-book-treatment-value',
        defaultValue: '',
        initialValue: keepPrevious ? previous : '',
        onSelect: syncDuration,
      });
      if (slots) {
        slots.replaceChildren();
        const next = payload?.data?.nextFreeSlot;
        if (next?.startsAt) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'floor-composer__slot is-active';
          chip.dataset.startsAt = typeof next.startsAt === 'string'
            ? next.startsAt
            : new Date(next.startsAt).toISOString();
          chip.textContent = next.time ? `Prochain libre ${next.time}` : 'Prochain libre';
          chip.addEventListener('click', () => {
            slots.querySelectorAll('.floor-composer__slot').forEach((el) => el.classList.remove('is-active'));
            chip.classList.add('is-active');
          });
          slots.appendChild(chip);
        }
      }
      syncDuration(hidden.value);
    } catch (err) {
      if (isUnauthorizedError(err)) return;
    }
  }

  function initFloorComposer() {
    const form = $('floor-book-form');
    if (!form || form.dataset.floorBound === 'true') return;
    form.dataset.floorBound = 'true';
    void loadTreatmentCatalog();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const hint = $('floor-book-hint');
      if (hint) hint.hidden = true;
      try {
        const startsAt = selectedFloorSlotIso();
        if (!startsAt) {
          showToast('Choisissez le prochain créneau libre.', 'error');
          return;
        }
        const treatment = $('floor-book-treatment')?.value.trim();
        if (!treatment) {
          showToast('Choisissez un soin.', 'error');
          return;
        }
        await postRosterBooking({
          kind: 'visit',
          patientName: $('floor-book-name')?.value.trim(),
          phone: $('floor-book-phone')?.value.trim(),
          treatment,
          startsAt,
        });
        form.reset();
        window.DentaFlowSelect?.init?.({
          rootId: 'floor-book-treatment-root',
          hiddenId: 'floor-book-treatment',
          triggerId: 'floor-book-treatment-trigger',
          listId: 'floor-book-treatment-list',
          labelId: 'floor-book-treatment-value',
          defaultValue: '',
          initialValue: '',
        });
        showToast('Rendez-vous posé.', 'success');
        loadPlanning();
        void loadTreatmentCatalog();
      } catch (err) {
        showToast(err?.message || 'Impossible de poser le rendez-vous.', 'error');
      }
    });
    $('floor-walkin-btn')?.addEventListener('click', async () => {
      try {
        const treatment = $('floor-book-treatment')?.value.trim();
        if (!treatment) {
          showToast('Choisissez un soin.', 'error');
          return;
        }
        await postRosterBooking({
          kind: 'visit',
          walkIn: true,
          patientName: $('floor-book-name')?.value.trim(),
          phone: $('floor-book-phone')?.value.trim(),
          treatment,
        });
        $('floor-book-form')?.reset();
        window.DentaFlowSelect?.init?.({
          rootId: 'floor-book-treatment-root',
          hiddenId: 'floor-book-treatment',
          triggerId: 'floor-book-treatment-trigger',
          listId: 'floor-book-treatment-list',
          labelId: 'floor-book-treatment-value',
          defaultValue: '',
          initialValue: '',
        });
        showToast('Walk-in placé en salle d\'attente.', 'success');
        loadPlanning();
        void loadTreatmentCatalog();
      } catch (err) {
        showToast(err?.message || 'Aucun créneau walk-in.', 'error');
      }
    });
  }

  function renderLateList(records) {
    const list = $('late-list');
    if (!list) return;
    const late = (Array.isArray(records) ? records : [])
      .filter((row) => isVisitBooking(row) && isLateOnScheduledTime(row))
      .sort((a, b) => {
        const aTime = parseStartsAt(a.starts_at || a.startTime)?.getTime() || 0;
        const bTime = parseStartsAt(b.starts_at || b.startTime)?.getTime() || 0;
        return aTime - bTime;
      });
    list.replaceChildren();
    if (!late.length) {
      const empty = document.createElement('p');
      empty.className = 'late-list__empty';
      empty.textContent = 'Aucun retard sur l\'heure prévue.';
      list.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    late.forEach((record) => {
      const item = document.createElement('div');
      item.className = 'late-item';
      item.setAttribute('role', 'listitem');
      const time = document.createElement('span');
      time.className = 'late-item__time';
      time.textContent = formatRosterClock(record);
      const name = document.createElement('span');
      name.className = 'late-item__name';
      name.textContent = record.name || record.patient_name || 'Patient';
      const care = document.createElement('span');
      care.className = 'late-item__care';
      care.textContent = record.treatment || record.treatment_name || '';
      item.append(time, name, care);
      fragment.appendChild(item);
    });
    list.appendChild(fragment);
  }

  function createBoardCard(record) {
    const card = document.createElement('article');
    card.className = 'board-card';
    card.setAttribute('role', 'listitem');
    card.dataset.patientId = String(record.id || '');
    card.dataset.bookingId = String(record.id || '');

    const time = document.createElement('span');
    time.className = 'board-card__time';
    time.textContent = formatRosterClock(record);

    const name = document.createElement('span');
    name.className = 'board-card__name';
    name.textContent = record.name || record.patient_name || 'Patient';

    const care = document.createElement('span');
    care.className = 'board-card__care';
    care.textContent = record.treatment || record.treatment_name || '';

    card.append(time, name, care);

    if (boardColumnForStatus(record.status) === 'care') {
      const elapsed = document.createElement('span');
      elapsed.className = 'board-card__elapsed';
      const scheduled = parseStartsAt(record.starts_at || record.rawDate);
      const started = parseStartsAt(record.care_started_at) || scheduled;
      const duration = Number(record.duration_min) > 0 ? Number(record.duration_min) : 30;
      const expected = scheduled ? new Date(scheduled.getTime() + duration * 60000) : null;
      const mins = started ? Math.max(0, Math.round((Date.now() - started.getTime()) / 60000)) : 0;
      elapsed.textContent = `Écoulé ${mins} min · fin ${expected ? formatRosterClock({ starts_at: expected }) : ''}`;
      card.appendChild(elapsed);
    }

    if (boardColumnForStatus(record.status) === 'done') {
      const actions = document.createElement('div');
      actions.className = 'board-card__actions';
      const recallBtn = document.createElement('button');
      recallBtn.type = 'button';
      recallBtn.textContent = '6 mois';
      recallBtn.addEventListener('click', () => void postRecallForRecord(record));
      actions.appendChild(recallBtn);
      card.appendChild(actions);
    }

    const select = document.createElement('select');
    select.className = 'status-select';
    select.dataset.bookingId = String(record.id || '');
    const current = record.status || 'Confirmé';
    const options = STATUS_OPTIONS.includes(current) ? STATUS_OPTIONS : [current, ...STATUS_OPTIONS];
    options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      if (opt === current) option.selected = true;
      select.appendChild(option);
    });
    select.dataset.previousStatus = current;

    card.appendChild(select);
    return card;
  }

  function renderStatusBoard(records) {
    const columns = {
      incoming: $('board-incoming'),
      waiting: $('board-waiting'),
      care: $('board-care'),
      done: $('board-done'),
    };
    if (!columns.incoming) return;

    Object.values(columns).forEach((col) => col.replaceChildren());
    const buckets = { incoming: [], waiting: [], care: [], done: [] };
    (Array.isArray(records) ? records : []).forEach((record) => {
      if (!isVisitBooking(record)) return;
      const col = boardColumnForStatus(record.status);
      if (col) buckets[col].push(record);
    });

    Object.entries(buckets).forEach(([key, rows]) => {
      const host = columns[key];
      if (!host) return;
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'status-board__empty';
        empty.textContent = key === 'care' ? 'Fauteuil libre' : 'Aucun';
        host.appendChild(empty);
        return;
      }
      const fragment = document.createDocumentFragment();
      rows
        .slice()
        .sort((a, b) => String(formatRosterClock(a)).localeCompare(String(formatRosterClock(b))))
        .forEach((record) => fragment.appendChild(createBoardCard(record)));
      host.appendChild(fragment);
    });
  }

  function refreshHandoffBookingOptions(records) {
    const select = $('handoff-booking');
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const general = document.createElement('option');
    general.value = '';
    general.textContent = 'Note générale';
    select.appendChild(general);
    (Array.isArray(records) ? records : []).forEach((record) => {
      if (!record?.id || !isVisitBooking(record)) return;
      if (isPulseCancelledStatus(record.status)) return;
      const option = document.createElement('option');
      option.value = String(record.id);
      option.dataset.patientName = record.name || record.patient_name || '';
      const clock = formatRosterClock(record);
      option.textContent = `${clock} · ${record.name || record.patient_name || 'Patient'}`;
      select.appendChild(option);
    });
    if (previous && [...select.options].some((opt) => opt.value === previous)) {
      select.value = previous;
    }
  }

  let resetHandoffCategorySelect = null;
  let setWaitlistPriorityValue = null;

  function initHandoffCategorySelect() {
    const api = window.DentaFlowSelect?.init?.({
      root: $('handoff-category-root'),
      hidden: $('handoff-category'),
      trigger: $('handoff-category-trigger'),
      list: $('handoff-category-list'),
      label: $('handoff-category-label'),
      defaultValue: 'Info',
    });
    resetHandoffCategorySelect = api ? () => api.setValue('Info') : null;
  }

  function getWaitlistPriorityInput() {
    return $('waitlist-priority-input') || $('waitlist-priority');
  }

  function initWaitlistPrioritySelect() {
    const api = window.DentaFlowSelect?.init?.({
      root: $('waitlist-priority-root'),
      hidden: $('waitlist-priority-input'),
      trigger: $('waitlist-priority-trigger'),
      list: $('waitlist-priority-list'),
      label: $('waitlist-priority-value'),
      defaultValue: 'Normale',
    });
    setWaitlistPriorityValue = api ? (value) => api.setValue(value || 'Normale') : null;
  }

  function initHandoffForm() {
    const form = $('handoff-form');
    if (!form) return;

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();

      const input = $('handoff-input');
      const categorySelect = $('handoff-category');
      const pinCheckbox = $('handoff-pin');
      const text = input?.value.trim();

      if (!text) {
        showToast('Saisissez une note avant de publier.', 'error');
        input?.focus();
        return;
      }

      const now = new Date();
      const time = now.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

      const profileName = (
        window.DentaFlowTheme?.getSessionDisplayName?.() ||
        volatileSettings.profileName ||
        DEFAULT_SETTINGS.profileName ||
        'Assistante'
      ).trim();
      const author = profileName.split(/\s+/)[0] || profileName;
      const authorInitials = extractInitials(profileName);
      const bookingSelect = $('handoff-booking');
      const bookingId = bookingSelect?.value || '';
      const patientName = bookingSelect?.selectedOptions?.[0]?.dataset?.patientName || '';

      const tempId = `temp-${Date.now()}`;
      const newNote = {
        id: tempId,
        text,
        type: 'manual',
        category: categorySelect?.value || 'Info',
        pinned: Boolean(pinCheckbox?.checked),
        author,
        time,
        readBy: [authorInitials],
        bookingId: bookingId || null,
        booking_id: bookingId || null,
        patientName: patientName || null,
        patient_name: patientName || null,
      };

      handoffNotes.unshift(newNote);
      form.reset();
      resetHandoffCategorySelect?.();
      renderHandoffBoard({ animate: true, highlightId: newNote.id });

      try {
        const response = await fetch(
          CONFIG.TEAM_NOTES_PROXY,
          {
            method: 'POST',
            credentials: 'include',
            headers: apiHeaders(),
            body: JSON.stringify({
              text: newNote.text,
              category: newNote.category,
              pinned: newNote.pinned,
              author: newNote.author,
              time: newNote.time,
              bookingId: newNote.bookingId,
              patientName: newNote.patientName,
            }),
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText.slice(0, 120)}`);
        }

        let result = null;
        try {
          result = await response.json();
        } catch {
          result = null;
        }

        const serverId = result?.id ?? result?.data?.id;
        if (serverId != null) {
          const saved = handoffNotes.find(note => note.id === tempId);
          if (saved) saved.id = serverId;
        }

        showToast('Note d\'équipe publiée.', 'success');
      } catch (error) {
        if (isFetchAborted(error)) {
          console.warn('[Sync] Fetch safely aborted by lifecycle controller. Suppressing UI error injection.');
          handoffNotes = handoffNotes.filter(note => note.id !== tempId);
          renderHandoffBoard();
          return;
        }
        console.error('[Handoff] POST failed:', error?.message || error);
        handoffNotes = handoffNotes.filter(note => note.id !== tempId);
        renderHandoffBoard();
        showToast('Échec de la publication. Réessayez.', 'error');
      }

      input?.focus();
    });
  }

  function showToast(message, type = 'info') {
    const toast = $('assistant-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('is-error', 'is-success', 'is-warning');
    if (type === 'error') toast.classList.add('is-error');
    if (type === 'success') toast.classList.add('is-success');
    if (type === 'warning') toast.classList.add('is-warning');
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
  }

  let preferencesToastTimer = null;

  function schedulePreferencesSavedToast() {
    clearTimeout(preferencesToastTimer);
    preferencesToastTimer = window.setTimeout(() => {
      showToast('Préférences enregistrées', 'success');
    }, 500);
  }

  function prefsStorageGet(key, fallback = '') {
    try {
      const value = localStorage.getItem(key);
      return value !== null ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function prefsStorageSet(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (error) {
      console.warn('[Settings] localStorage write failed:', error);
    }
  }

  function parsePrefsBool(value, fallback = true) {
    if (value === '' || value == null) return fallback;
    return value === 'true' || value === '1';
  }

  function bindPrefsField(el, storageKey, { onPersist } = {}) {
    if (!el || el.dataset.prefsBound === 'true') return;
    el.dataset.prefsBound = 'true';

    const persist = () => {
      const value = el.type === 'checkbox' ? el.checked : el.value;
      prefsStorageSet(storageKey, el.type === 'checkbox' ? String(value) : value);
      onPersist?.(value, el);
      schedulePreferencesSavedToast();
    };

    el.addEventListener('change', persist);
    if (el.type !== 'checkbox') {
      el.addEventListener('input', persist);
    }
  }

  function initGhostSelectPersist({
    rootId,
    hiddenId,
    triggerId,
    listId,
    labelId,
    storageKey,
    defaultValue,
    onPersist,
  }) {
    const stored = prefsStorageGet(storageKey, defaultValue);
    window.DentaFlowSelect?.init?.({
      rootId,
      hiddenId,
      triggerId,
      listId,
      labelId,
      defaultValue,
      initialValue: stored,
      once: true,
      onSelect: (value) => {
        prefsStorageSet(storageKey, value);
        onPersist?.(value);
        schedulePreferencesSavedToast();
      },
    });
  }

  function applyProfileForCurrentShell(name, specialty) {
    if (document.body.classList.contains('mode-assistant')) {
      applyUserProfile(name, specialty);
      return;
    }
    if (typeof globalThis.applyUserProfile === 'function') {
      globalThis.applyUserProfile(name, specialty);
    }
  }

  function initSettingsPrefsState() {
    const isAssistant = document.body.classList.contains('mode-assistant');
    const defaults = isAssistant ? {
      profileName: window.DentaFlowTheme?.getSessionDisplayName?.() || DEFAULT_SETTINGS.profileName || 'Assistante',
      profileSpecialty: window.DentaFlowTheme?.getSessionRoleLabel?.('assistant') || DEFAULT_SETTINGS.profileSpecialty,
    } : {
      profileName: window.DentaFlowTheme?.getSessionDisplayName?.() || 'Praticien',
      profileSpecialty: window.DentaFlowTheme?.getSessionRoleLabel?.('doctor') || 'Chirurgien-dentiste',
    };

    const nameEl = $('settings-profile-name');
    const roleEl = $('settings-profile-specialty');

    if (nameEl) {
      nameEl.value = defaults.profileName;
      nameEl.readOnly = true;
    }
    if (roleEl) {
      roleEl.value = defaults.profileSpecialty;
      roleEl.readOnly = true;
    }

    if (nameEl || roleEl) {
      applyProfileForCurrentShell(defaults.profileName, defaults.profileSpecialty);
    }

    const smsToggle = $('settings-sms-toggle');
    const emailToggle = $('settings-email-toggle');
    const smsKey = isAssistant ? 'df_asst_sms_reminders' : 'df_doc_sms_reminders';
    const emailKey = isAssistant ? 'df_asst_email_reminders' : 'df_doc_email_reminders';

    if (smsToggle) {
      smsToggle.checked = parsePrefsBool(prefsStorageGet(smsKey, ''), smsToggle.checked);
      bindPrefsField(smsToggle, smsKey, {
        onPersist: (value) => saveSettings({ smsReminders: value }),
      });
    }
    if (emailToggle) {
      emailToggle.checked = parsePrefsBool(prefsStorageGet(emailKey, ''), emailToggle.checked);
      bindPrefsField(emailToggle, emailKey, {
        onPersist: (value) => saveSettings({ emailReminders: value }),
      });
    }

    const goalEl = $('settings-daily-goal');
    if (goalEl) {
      const storedGoal = prefsStorageGet('df_doc_daily_goal', goalEl.value || '');
      if (storedGoal) goalEl.value = storedGoal;
      bindPrefsField(goalEl, 'df_doc_daily_goal', {
        onPersist: (value) => {
          const val = parseInt(String(value), 10);
          if (Number.isFinite(val) && val >= 1000 && typeof globalThis.applyDoctorDailyGoal === 'function') {
            globalThis.applyDoctorDailyGoal(val);
          }
        },
      });
      const initialGoal = parseInt(goalEl.value, 10);
      if (Number.isFinite(initialGoal) && initialGoal >= 1000 && typeof globalThis.applyDoctorDailyGoal === 'function') {
        globalThis.applyDoctorDailyGoal(initialGoal);
      }
    }

    const dayStartEl = $('settings-day-start');
    const dayEndEl = $('settings-day-end');
    if (dayStartEl) {
      const stored = prefsStorageGet('df_doc_day_start', dayStartEl.value || '09:00');
      dayStartEl.value = stored;
      bindPrefsField(dayStartEl, 'df_doc_day_start');
    }
    if (dayEndEl) {
      const stored = prefsStorageGet('df_doc_day_end', dayEndEl.value || '18:00');
      dayEndEl.value = stored;
      bindPrefsField(dayEndEl, 'df_doc_day_end');
    }

    const emergencyToggle = $('settings-emergency-buffer-toggle');
    const emergencySlotsEl = $('settings-emergency-slots');
    const syncEmergencySlotsState = (enabled) => {
      if (!emergencySlotsEl) return;
      emergencySlotsEl.disabled = !enabled;
      emergencySlotsEl.classList.toggle('is-disabled', !enabled);
    };

    if (emergencyToggle) {
      emergencyToggle.checked = parsePrefsBool(prefsStorageGet('df_doc_emergency_buffer', 'true'), true);
      syncEmergencySlotsState(emergencyToggle.checked);
      bindPrefsField(emergencyToggle, 'df_doc_emergency_buffer', {
        onPersist: (value) => syncEmergencySlotsState(value),
      });
    }
    if (emergencySlotsEl) {
      const storedSlots = prefsStorageGet('df_doc_emergency_slots', emergencySlotsEl.value || '2');
      emergencySlotsEl.value = storedSlots;
      syncEmergencySlotsState(emergencyToggle ? emergencyToggle.checked : true);
      bindPrefsField(emergencySlotsEl, 'df_doc_emergency_slots');
    }

    initGhostSelectPersist({
      rootId: 'settings-planning-view-root',
      hiddenId: 'settings-planning-view',
      triggerId: 'settings-planning-view-trigger',
      listId: 'settings-planning-view-list',
      labelId: 'settings-planning-view-label-value',
      storageKey: 'df_asst_planning_view',
      defaultValue: 'chronologique',
    });

    const soundTeamToggle = $('settings-sound-team-toggle');
    const soundArrivalToggle = $('settings-sound-arrival-toggle');
    if (soundTeamToggle) {
      soundTeamToggle.checked = parsePrefsBool(prefsStorageGet('df_asst_sound_team', 'true'), true);
      bindPrefsField(soundTeamToggle, 'df_asst_sound_team');
    }
    if (soundArrivalToggle) {
      soundArrivalToggle.checked = parsePrefsBool(prefsStorageGet('df_asst_sound_arrival', 'true'), true);
      bindPrefsField(soundArrivalToggle, 'df_asst_sound_arrival');
    }
  }

  window.initSettingsPrefsState = initSettingsPrefsState;

  const DEPLOYING_FEATURE_NOTICES = {
    dailyReport: {
      toast: 'Cette fonctionnalité est en cours de déploiement et sera disponible prochainement.',
      tooltip: 'Génération du rapport bientôt disponible',
    },
    forceReminders: {
      toast: 'Cette fonctionnalité est en cours de déploiement et sera disponible prochainement.',
      tooltip: 'Rappels automatiques bientôt disponibles',
    },
    blockSlot: {
      toast: 'Cette fonctionnalité est en cours de déploiement et sera disponible prochainement.',
      tooltip: 'Blocage de créneau bientôt disponible',
    },
    delayAlert: {
      toast: 'Cette fonctionnalité est en cours de déploiement et sera disponible prochainement.',
      tooltip: 'Alerte retard bientôt disponible',
    },
  };

  function wireDeployingFeatureButton(button, notice) {
    if (!button || button.dataset.deployingGuard === 'true') return;
    button.dataset.deployingGuard = 'true';
    button.disabled = false;
    button.setAttribute('aria-disabled', 'true');
    button.classList.add('v-disabled');
    button.setAttribute('title', notice.tooltip);
    button.dataset.tooltip = notice.tooltip;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      showToast(notice.toast, 'info');
    });
  }

  function guardDeployingFeatureButtons() {
    wireDeployingFeatureButton($('btn-daily-report'), DEPLOYING_FEATURE_NOTICES.dailyReport);
    wireDeployingFeatureButton($('btn-force-reminders'), DEPLOYING_FEATURE_NOTICES.forceReminders);
    wireDeployingFeatureButton($('btn-block-slot'), DEPLOYING_FEATURE_NOTICES.blockSlot);
    wireDeployingFeatureButton($('btn-alerte-retard'), DEPLOYING_FEATURE_NOTICES.delayAlert);
    wireDeployingFeatureButton($('waitlist-popover-export'), DEPLOYING_FEATURE_NOTICES.dailyReport);
  }

  function escapeCsvCell(value) {
    const text = String(value ?? '');
    if (/[;"\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function isCalendarEventToday(event) {
    const start = event?.start;
    if (!start) return false;
    const date = start instanceof Date ? start : new Date(start);
    if (Number.isNaN(date.getTime())) return false;
    return date.toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' }) === getTodayDateKey();
  }

  function mapCalendarEventToReportRow(event) {
    const start = event.start instanceof Date ? event.start : new Date(event.start);
    const time = Number.isNaN(start.getTime())
      ? '--:--'
      : start.toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Africa/Casablanca',
        });
    const title = String(event.title ?? '').trim();
    const dashIdx = title.indexOf('—');
    const patient = dashIdx >= 0 ? title.slice(dashIdx + 1).trim() : title || 'Non spécifié';
    const type = event.extendedProps?.type
      ?? event.extendedProps?.treatment
      ?? (dashIdx >= 0 ? title.slice(0, dashIdx).trim() : 'Consultation');
    const statut = event.extendedProps?.status
      ?? event.extendedProps?.statut
      ?? 'Confirmé';
    return [time, patient, type, statut];
  }

  function mapRosterRecordToReportRow(record) {
    return [
      record.time || formatAppointmentTime(record.rawDate),
      record.name || 'Non spécifié',
      record.treatment || 'Consultation',
      record.status || 'Confirmé',
    ];
  }

  function getAssistantCalendarInstance() {
    if (window.calendar) return window.calendar;
    if (dashboardCalendar) return dashboardCalendar;
    initDashboardCalendar();
    return window.calendar || dashboardCalendar;
  }

  function generateDailyReport() {
    const calendar = getAssistantCalendarInstance();
    let rows = [];

    if (calendar && typeof calendar.getEvents === 'function') {
      rows = calendar.getEvents()
        .filter(isCalendarEventToday)
        .sort((a, b) => (a.start?.getTime?.() ?? 0) - (b.start?.getTime?.() ?? 0))
        .map(mapCalendarEventToReportRow);
    }

    if (!rows.length && allRosterRecords.length) {
      rows = sortRosterByTime(filterTodayRosterRecords(allRosterRecords))
        .map(mapRosterRecordToReportRow);
    }

    const header = ['Heure', 'Patient', 'Type', 'Statut'];
    const csvLines = [header, ...rows].map((line) => line.map(escapeCsvCell).join(';'));
    const csvContent = `\uFEFF${csvLines.join('\r\n')}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const dateKey = getTodayDateKey();
    const filename = `Rapport_Dentaflow_${dateKey}.csv`;

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);

    const countLabel = rows.length === 1 ? '1 rendez-vous' : `${rows.length} rendez-vous`;
    showToast(
      rows.length
        ? `Rapport exporté. ${countLabel}.`
        : 'Rapport exporté. Aucun rendez-vous pour aujourd\'hui.',
      'success'
    );
  }

  function initSuperpouvoirs() {
    const exportBtn = $('btn-export-excel');

    if (exportBtn && exportBtn.dataset.superWired !== 'true') {
      exportBtn.dataset.superWired = 'true';
      exportBtn.addEventListener('click', (event) => {
        event.preventDefault();
        generateDailyReport();
      });
    }
  }

  function setSyncIndicator(state) {
    const dot = assistantQuery('.sync-dot');
    const label = assistantQuery('.sync-label');
    if (!dot || !label) return;
    dot.classList.remove('ok', 'loading', 'error');
    dot.classList.add(state);
    if (state === 'loading') label.textContent = 'Synchronisation en cours…';
    else if (state === 'error') label.textContent = 'Hors-ligne · Mode dégradé';
    else label.textContent = 'Synchronisé';
  }

  /**
   * Extract HH:mm from appointment datetime (ISO or parseable string).
   * Returns "--:--" when missing or invalid.
   */
  function formatAppointmentTime(rawDate) {
    if (rawDate == null || rawDate === '') return '--:--';

    const parsed = new Date(rawDate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Africa/Casablanca',
      });
    }

    const match = String(rawDate).match(/(\d{1,2}):(\d{2})/);
    if (match) {
      return `${match[1].padStart(2, '0')}:${match[2]}`;
    }

    return '--:--';
  }

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

    if (Array.isArray(payload)) {
      return payload;
    }

    if (typeof payload !== 'object') return [];

    if (looksLikeRosterRecord(payload)) {
      return [payload];
    }

    const arrayKeys = ['data', 'results', 'items', 'records', 'appointments', 'body', 'json'];
    for (const key of arrayKeys) {
      if (Array.isArray(payload[key])) return payload[key];
      if (looksLikeRosterRecord(payload[key])) return [payload[key]];
    }

    // Object map of rows: { "0": {...}, "1": {...} }
    const values = Object.values(payload);
    if (values.length && values.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
      return values;
    }

    return [];
  }

  function isBenignEmptyRosterProxyPayload(payload) {
    if (!payload || typeof payload !== 'object' || payload.ok !== false) return false;
    const detail = String(payload.details || payload.error || '').trim();
    if (!detail) return true;
    return /réponse vide|respond to webhook/i.test(detail);
  }

  function unwrapRosterProxyPayload(payload) {
    if (payload && typeof payload === 'object' && payload.ok === false) {
      if (isBenignEmptyRosterProxyPayload(payload)) {
        return [];
      }
      const detail = String(payload.details || payload.error || '').trim();
      const friendlyMessage = /réponse vide|respond to webhook/i.test(detail)
        ? 'Aucun rendez-vous trouvé.'
        : (detail || 'Aucun rendez-vous trouvé.');
      throw new Error(friendlyMessage);
    }
    if (payload && typeof payload === 'object' && payload.ok === true && 'data' in payload) {
      const inner = payload.data;
      if (Array.isArray(inner)) return inner;
      if (looksLikeRosterRecord(inner)) return [inner];
      return parseRosterResponse(inner);
    }
    return payload;
  }

  /** Scalar passthrough — Postgres fields are plain strings. */
  function extractScalarValue(field) {
    if (field == null) return '';
    if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') {
      return String(field);
    }
    return '';
  }

  function buildRosterPipeline(payload) {
    const unwrapped = unwrapRosterProxyPayload(payload);
    const rawRows = parseRosterResponse(unwrapped);
    const normalized = sortRosterByTime(
      rawRows
        .map(normalizeRosterRecord)
        .filter(Boolean)
        .filter(record => !isGhostRosterRecord(record))
    );
    const todayRecords = filterTodayRosterRecords(normalized);

    return { rawRows, normalized, todayRecords };
  }

  function resolveRosterUrl() {
    return CONFIG.ROSTER_PROXY;
  }

  function isGhostRosterRecord(record) {
    return (
      record.name === 'Non spécifié' &&
      (record.rawDate == null || record.rawDate === '')
    );
  }

  function getTodayDateKey() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
  }

  function getTomorrowDateKey() {
    const [year, month, day] = getTodayDateKey().split('-').map(Number);
    const cursor = new Date(year, month - 1, day);
    cursor.setDate(cursor.getDate() + 1);
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function getAppointmentDateKey(rawDate) {
    if (rawDate == null || rawDate === '') return null;
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
  }

  function isBulkPendingStatus(status) {
    return String(status || '').trim().toLowerCase() === BULK_PENDING_STATUS.toLowerCase();
  }

  function parseBookingRowId(raw) {
    if (raw == null || raw === '') return null;
    const text = String(raw).trim();
    if (!text) return null;
    const numericId = Number(text);
    if (Number.isFinite(numericId) && String(numericId) === text) return numericId;
    return text;
  }

  function extractBookingRowId(record) {
    const id = record?.rowId ?? record?.id;
    return parseBookingRowId(id);
  }

  function gatherTomorrowPendingRecords(records) {
    const tomorrowKey = getTomorrowDateKey();
    return records.filter((record) => {
      if (!record) return false;
      if (getAppointmentDateKey(record.rawDate) !== tomorrowKey) return false;
      return isBulkPendingStatus(record.status);
    });
  }

  function gatherTomorrowPendingRowIds(records) {
    return gatherTomorrowPendingRecords(records)
      .map(extractBookingRowId)
      .filter((rowId) => rowId != null);
  }

  function fillStatusPillElement(node, label, modifierClass = '') {
    node.className = ['status-pill', modifierClass].filter(Boolean).join(' ');
    if (window.DentaFlowDom?.setStatusPill) {
      window.DentaFlowDom.setStatusPill(node, label);
    } else {
      node.replaceChildren();
      node.appendChild(document.createTextNode(label || 'Non renseigné'));
    }
  }

  function createStatusPillElement(label, modifierClass = '') {
    if (window.DentaFlowDom?.createStatusPill) {
      return window.DentaFlowDom.createStatusPill(label, modifierClass);
    }
    const pill = document.createElement('span');
    fillStatusPillElement(pill, label, modifierClass);
    return pill;
  }

  function applyOptimisticBulkStatus(records, newStatus, pillModifierClass, options = {}) {
    const { markRowCancelled = false, panelModifierClass = null } = options;
    const resolvedModifier = pillModifierClass || getCrmStatutTagClass(newStatus);
    const snapshots = [];

    const mountPillIn = (parent) => {
      parent.replaceChildren();
      parent.appendChild(createStatusPillElement(newStatus, resolvedModifier));
    };

    records.forEach((record) => {
      const id = String(record.id);
      const snapshot = {
        id,
        previousStatus: record.status,
        crmPatientStatus: crmPatientsById[id]?.status ?? null,
        dom: [],
      };

      record.status = newStatus;

      const allIdx = allRosterRecords.findIndex((r) => String(r.id) === id);
      if (allIdx >= 0) allRosterRecords[allIdx].status = newStatus;

      const rosterIdx = rosterData.findIndex((r) => String(r.id) === id);
      if (rosterIdx >= 0) rosterData[rosterIdx].status = newStatus;

      if (crmPatientsById[id]) {
        crmPatientsById[id].status = newStatus;
      }

      const patchInner = (el) => {
        if (!el) return;
        snapshot.dom.push({ mode: 'inner', el, html: el.innerHTML });
        mountPillIn(el);
      };

      const patchOuter = (el) => {
        if (!el) return;
        snapshot.dom.push({ mode: 'outer', parent: el.parentElement, html: el.outerHTML });
        el.replaceWith(createStatusPillElement(newStatus, resolvedModifier));
      };

      const patchRowCancelled = (el) => {
        if (!el || !markRowCancelled) return;
        snapshot.dom.push({
          mode: 'row-cancelled',
          el,
          wasCancelled: el.classList.contains('is-cancelled'),
        });
        el.classList.add('is-cancelled');
      };

      const timelineItem = document.querySelector(`#planning-timeline .timeline-item[data-patient-id="${id}"]`);
      const timelineStatusWrap = timelineItem?.querySelector('.timeline-item__status');
      if (timelineStatusWrap) {
        const select = timelineStatusWrap.querySelector('.status-select');
        if (select) {
          snapshot.dom.push({ mode: 'select', el: select, value: select.value });
          select.value = newStatus;
          applyMatteSelectSkin(select, newStatus);
        } else {
          patchInner(timelineStatusWrap);
        }
      }
      patchRowCancelled(timelineItem);

      const legacyRow = document.querySelector(`#roster-tbody tr[data-patient-id="${id}"]`);
      if (legacyRow?.cells?.[4]) patchInner(legacyRow.cells[4]);
      patchRowCancelled(legacyRow);

      const crmRow = document.querySelector(`#crm-table-body tr[data-patient-id="${id}"]`);
      if (crmRow?.cells?.[4]) patchInner(crmRow.cells[4]);

      const rosterCard = document.querySelector(`.roster-card[data-patient-id="${id}"]`);
      const cardSelect = rosterCard?.querySelector('.status-select');
      if (cardSelect) patchOuter(cardSelect);
      patchRowCancelled(rosterCard);

      const panelStatus = $('crm-panel-status');
      const activeRow = document.querySelector('#crm-table-body .crm-table-row.active-row');
      if (panelStatus && activeRow?.dataset?.patientId === id) {
        const panelClass = panelModifierClass
          || getCrmStatutTagClass(newStatus);
        snapshot.dom.push({
          mode: 'panel',
          className: panelStatus.className,
          innerHTML: panelStatus.innerHTML,
        });
        panelStatus.className = `crm-side-panel-statut status-pill ${panelClass}`.trim();
        fillStatusPillElement(panelStatus, newStatus, panelClass);
      }

      snapshots.push(snapshot);
    });

    return snapshots;
  }

  function applyOptimisticBulkConfirm(records) {
    return applyOptimisticBulkStatus(
      records,
      'Confirmé',
      getCrmStatutTagClass('Confirmé')
    );
  }

  function applyOptimisticBulkCancel(records) {
    return applyOptimisticBulkStatus(
      records,
      'Annulé',
      'status-pill--attente',
      { markRowCancelled: true, panelModifierClass: 'status-pill--attente' }
    );
  }

  function revertOptimisticBulkSnapshots(snapshots) {
    snapshots.forEach((snapshot) => {
      const { id, previousStatus, crmPatientStatus, dom } = snapshot;

      const restoreStatus = (collection) => {
        const idx = collection.findIndex((r) => String(r.id) === id);
        if (idx >= 0) collection[idx].status = previousStatus;
      };

      restoreStatus(allRosterRecords);
      restoreStatus(rosterData);

      const memoryRecord = allRosterRecords.find((r) => String(r.id) === id)
        || rosterData.find((r) => String(r.id) === id);
      if (memoryRecord) memoryRecord.status = previousStatus;

      if (crmPatientStatus != null && crmPatientsById[id]) {
        crmPatientsById[id].status = crmPatientStatus;
      }

      dom.forEach((patch) => {
        if (patch.mode === 'select' && patch.el) {
          patch.el.value = patch.value;
          applyMatteSelectSkin(patch.el, patch.value);
          return;
        }

        if (patch.mode === 'inner' && patch.el) {
          patch.el.innerHTML = patch.html;
          return;
        }

        if (patch.mode === 'outer' && patch.parent) {
          const pill = patch.parent.querySelector('.status-pill');
          if (pill) pill.outerHTML = patch.html;
          return;
        }

        if (patch.mode === 'row-cancelled' && patch.el) {
          patch.el.classList.toggle('is-cancelled', patch.wasCancelled);
          return;
        }

        if (patch.mode === 'panel') {
          const panelStatus = $('crm-panel-status');
          if (!panelStatus) return;
          panelStatus.className = patch.className;
          panelStatus.innerHTML = patch.innerHTML;
        }
      });
    });
  }

  function revertOptimisticBulkConfirm(snapshots) {
    revertOptimisticBulkSnapshots(snapshots);
  }

  function getSelectedRowIdsForApi(ids = selectedPatientIds) {
    return ids
      .map((id) => {
        const direct = parseBookingRowId(id);
        if (direct != null) return direct;
        const record = getRecordsForSelectedIds([id])[0];
        return record ? extractBookingRowId(record) : null;
      })
      .filter((rowId) => rowId != null);
  }

  function formatScheduleDate(rawDate) {
    if (rawDate == null || rawDate === '') return '';
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
  }

  function extractCancelMetadataFromRecord(record) {
    const row = document.querySelector(`#planning-timeline .timeline-item[data-patient-id="${String(record.id)}"]`)
      || document.querySelector(`#roster-tbody tr[data-patient-id="${String(record.id)}"]`);
    const rowId = extractBookingRowId(record);
    return {
      rowId,
      calBookingId: row?.dataset?.calBookingId || record.calBookingId || '',
      scheduleDate: String(row?.dataset?.scheduleDate ?? formatScheduleDate(record.rawDate)).trim(),
      startTime: String(row?.dataset?.startTime ?? record.time ?? '').trim(),
      practitioner: String(row?.dataset?.practitioner ?? record.practitioner ?? '').trim() || 'Non assigné',
    };
  }

  function getBookingIdForApi(record) {
    return String(record?.id || record?.calBookingId || record?.cal_booking_uid || '').trim();
  }

  function getSelectedBulkCancelPayload(ids = selectedPatientIds) {
    const records = getRecordsForSelectedIds(ids);
    const appointments = records.map(extractCancelMetadataFromRecord);
    return {
      records,
      rowIds: appointments.map((entry) => entry.rowId).filter((id) => id != null),
      calBookingIds: appointments.map((entry) => entry.calBookingId || ''),
      appointments,
    };
  }

  function isSameRowId(a, b) {
    return String(a) === String(b);
  }

  function restoreBulkSelection(ids) {
    selectedPatientIds = ids
      .map((id) => parseBookingRowId(id))
      .filter((rowId) => rowId != null);
    document.querySelectorAll('#planning-timeline .row-checkbox, #roster-tbody .row-checkbox').forEach((checkbox) => {
      const rowId = parseBookingRowId(checkbox.dataset.rowId);
      checkbox.checked = rowId != null && selectedPatientIds.includes(rowId);
    });
    updateBulkBarUI();
  }

  async function postBulkAction(endpoint, payload) {
    await window.DentaFlowAuth?.requireSession?.();

    const body = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { ...payload }
      : { rowIds: payload };

    const response = await fetch(
      endpoint,
      {
        method: 'POST',
        credentials: 'include',
        headers: apiHeaders(),
        body: JSON.stringify(body),
      }
    );

    assertAuthorizedResponse(response);

    const rawText = await response.text();
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = { raw: rawText };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${String(rawText).slice(0, 160)}`);
    }

    if (parsed && parsed.ok === false) {
      throw new Error(parsed.error || parsed.details || 'Upstream rejected request');
    }

    if (parsed && parsed.success === false) {
      throw new Error(parsed.message || parsed.error || 'Bulk action failed');
    }

    return parsed ?? { success: true, message: rawText || 'OK' };
  }

  function toastFromSmsResult(result) {
    const count = Number(result?.dispatchedCount || 0);
    if (count > 0) {
      showToast(count === 1 ? 'SMS envoyé.' : `${count} SMS envoyés.`, 'success');
      return;
    }
    if (result?.twilioConfigured === false) {
        showToast("SMS non envoyé. Twilio n'est pas configuré.", 'warning');
      return;
    }
    showToast('Aucun SMS envoyé.', 'warning');
  }

  async function postBulkStatusUpdates(records, newStatus) {
    const rows = Array.isArray(records) ? records : [];
    if (!rows.length) {
      throw new Error('Aucun identifiant de rendez-vous valide.');
    }
    const results = [];
    for (const record of rows) {
      const bookingId = getBookingIdForApi(record);
      if (!bookingId) {
        throw new Error('Aucun identifiant de rendez-vous valide.');
      }
      results.push(await postBulkAction(CONFIG.ENDPOINTS.UPDATE_STATUS, {
        bookingId,
        newStatus,
      }));
    }
    return { ok: true, results };
  }

  function updateBulkBarUI() {
    const bar = $('bulk-action-bar');
    const countEl = $('bulk-selection-count');
    if (!bar) return;

    if (selectedPatientIds.length > 0) {
      if (countEl) {
        countEl.textContent = `${selectedPatientIds.length} Patient(s) Sélectionné(s)`;
      }
      bar.classList.remove('bulk-bar-hidden');
      bar.classList.add('bulk-bar-visible');
      return;
    }

    bar.classList.remove('bulk-bar-visible');
    bar.classList.add('bulk-bar-hidden');
    if (countEl) countEl.textContent = '';
  }

  function clearBulkSelection() {
    selectedPatientIds = [];
    document.querySelectorAll('#planning-timeline .row-checkbox, #roster-tbody .row-checkbox').forEach((checkbox) => {
      checkbox.checked = false;
    });
    updateBulkBarUI();
  }

  function getRecordsForSelectedIds(ids = selectedPatientIds) {
    return ids
      .map((id) => {
        const rowId = parseBookingRowId(id);
        if (rowId == null) return null;
        return rosterData.find((record) => isSameRowId(record.id, rowId))
          || allRosterRecords.find((record) => isSameRowId(record.id, rowId));
      })
      .filter(Boolean);
  }

  function removeRecordsFromLocalState(ids) {
    const idSet = new Set(
      ids.map((id) => String(parseBookingRowId(id) ?? id))
    );
    rosterData = rosterData.filter((record) => !idSet.has(String(record.id)));
    allRosterRecords = allRosterRecords.filter((record) => !idSet.has(String(record.id)));
  }

  async function animateRowsVaporize(rowIds) {
    const rows = rowIds
      .map((id) => document.querySelector(`#planning-timeline .timeline-item[data-patient-id="${String(id)}"]`)
        || document.querySelector(`#roster-tbody tr[data-patient-id="${String(id)}"]`))
      .filter(Boolean);

    if (!rows.length) return;

    const removeRowsAndRelatedCards = () => {
      rows.forEach((row) => {
        const patientId = row.dataset.patientId;
        row.remove();
        document.querySelector(`.roster-card[data-patient-id="${patientId}"]`)?.remove();
      });

      const timeline = $('planning-timeline');
      if (timeline && !timeline.querySelector('.timeline-item')) {
        timeline.replaceChildren();
        mountEmptyState('planning-empty-state', { message: EMPTY_STATE_DEFAULT_MESSAGE });
      }

      const tbody = $('roster-tbody');
      if (tbody && !tbody.querySelector('tr:not(.roster-empty):not(.roster-loading):not(.roster-error)')) {
        tbody.replaceChildren();
        const emptyRow = document.createElement('tr');
        emptyRow.className = 'roster-empty';
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.textContent = 'Aucun rendez-vous prévu pour aujourd\'hui.';
        emptyRow.appendChild(cell);
        tbody.appendChild(emptyRow);
      }

      const cards = $('roster-cards');
      if (cards && !cards.querySelector('.roster-card')) {
        cards.replaceChildren();
        const empty = document.createElement('p');
        empty.className = 'roster-cards__empty';
        empty.textContent = 'Aucun rendez-vous prévu pour aujourd\'hui.';
        cards.appendChild(empty);
      }
    };

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced || typeof gsap === 'undefined') {
      removeRowsAndRelatedCards();
      return;
    }

    const cells = rows.flatMap((row) => {
      if (row.classList.contains('timeline-item')) {
        const card = row.querySelector('.timeline-item__card');
        return card ? [card] : [row];
      }
      return Array.from(row.querySelectorAll('td'));
    });

    await new Promise((resolve) => {
      gsap.to(cells, {
        opacity: 0,
        paddingTop: 0,
        paddingBottom: 0,
        lineHeight: 0,
        height: 0,
        duration: 0.5,
        ease: 'expo.inOut',
        onComplete: () => {
          removeRowsAndRelatedCards();
          resolve();
        },
      });
    });
  }

  async function bulkConfirmSelected() {
    if (!selectedPatientIds.length) return;

    const ids = [...selectedPatientIds];
    const records = getRecordsForSelectedIds(ids);
    const optimisticSnapshots = applyOptimisticBulkConfirm(records);

    try {
      await postBulkStatusUpdates(records, 'Confirmé');

      selectedPatientIds = [];
      document.querySelectorAll('#planning-timeline .row-checkbox, #roster-tbody .row-checkbox').forEach((checkbox) => {
        checkbox.checked = false;
      });
      updateBulkBarUI();
      animateInlineConfirmSuccess(ids);
      showToast(`${ids.length} rendez-vous confirmés avec succès`, 'success');
    } catch (error) {
      if (isFetchAborted(error)) {
        console.warn('[Sync] Fetch safely aborted by lifecycle controller. Suppressing UI error injection.');
        revertOptimisticBulkSnapshots(optimisticSnapshots);
        return;
      }
      console.error('[Bulk Confirm] Failed:', error?.message || error);
      revertOptimisticBulkSnapshots(optimisticSnapshots);
      showToast('Erreur de synchronisation. Annulation des changements.', 'error');
    }
  }

  async function bulkCancelSelected() {
    if (!selectedPatientIds.length) return;

    const ids = [...selectedPatientIds];
    const records = getRecordsForSelectedIds(ids);
    const cancelName = records.length === 1
      ? (records[0]?.name || 'ce patient')
      : `${records.length} patients`;
    const confirmed = await askConfirm(
      `Annuler le rendez-vous de ${cancelName} ? Cette action est irréversible.`
    );
    if (!confirmed) return;

    const optimisticSnapshots = applyOptimisticBulkCancel(records);

    try {
      console.log('[Bulk Cancel] Dispatch | count: ' + records.length);
      const [cancelResult] = await Promise.all([
        postBulkStatusUpdates(records, 'Annulé'),
        animateRowsVaporize(ids),
      ]);

      removeRecordsFromLocalState(ids);
      updateRosterStats(rosterData);

      clearBulkSelection();
      if (cancelResult?.status === 'partial_success') {
        showToast(
          'Erreur de synchronisation avec la base de données',
          'warning'
        );
      } else {
        showToast('Rendez-vous annulés avec succès', 'success');
      }
    } catch (error) {
      if (isFetchAborted(error)) {
        console.warn('[Sync] Fetch safely aborted by lifecycle controller. Suppressing UI error injection.');
        revertOptimisticBulkSnapshots(optimisticSnapshots);
        return;
      }
      console.error('[Bulk Cancel] Failed:', error?.message || error);
      revertOptimisticBulkSnapshots(optimisticSnapshots);
      loadPlanning();
      showToast('Erreur: Annulation échouée.', 'error');
    }
  }

  async function bulkSmsSelected() {
    if (!selectedPatientIds.length) return;

    const n = selectedPatientIds.length;
    const confirmed = await askConfirm(
      `Envoyer un SMS à ${n} patients ? Cette action est irréversible.`
    );
    if (!confirmed) return;

    const ids = [...selectedPatientIds];
    const targetRowIds = getSelectedRowIdsForApi(ids);
    const btnBulkSms = $('btn-bulk-sms');

    clearBulkSelection();
    showToast('Envoi des SMS en cours d\'exécution en arrière-plan...', 'info');

    btnBulkSms?.classList.add('is-loading');
    if (btnBulkSms) btnBulkSms.disabled = true;

    try {
      console.log('[Bulk SMS] Dispatch | RowIDs: ' + (targetRowIds?.length || 0));
      const result = await postBulkAction(CONFIG.ENDPOINTS.BULK_SMS, { rowIds: targetRowIds });
      toastFromSmsResult(result);
    } catch (error) {
      console.error('[Bulk SMS] Failed:', error?.message || error);
      restoreBulkSelection(ids);
      showToast('Erreur: envoi SMS échoué.', 'error');
    } finally {
      btnBulkSms?.classList.remove('is-loading');
      if (btnBulkSms) btnBulkSms.disabled = false;
    }
  }

  function initBulkActionBar() {
    // Checkbox + bulk actions use document-level delegation (bindCoreDelegation).
  }

  function handleDelegatedCheckboxChange(event) {
    if (!event.target.classList.contains('row-checkbox')) return;
    if (!event.target.closest('#planning-timeline, #roster-tbody')) return;

    const rowId = parseBookingRowId(event.target.dataset.rowId);
    if (rowId == null) return;

    if (event.target.checked) {
      if (!selectedPatientIds.includes(rowId)) selectedPatientIds.push(rowId);
    } else {
      selectedPatientIds = selectedPatientIds.filter((id) => id !== rowId);
    }

    updateBulkBarUI();
  }

  function isAppointmentToday(rawDate) {
    if (rawDate == null || rawDate === '') return false;
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' }) === getTodayDateKey();
  }

  /** Planning du Jour — only today's appointments; undated rows are excluded. */
  function filterTodayRosterRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return [];
    return records.filter(record => isAppointmentToday(record.rawDate));
  }

  function sortRosterByTime(records) {
    return [...records].sort((a, b) => {
      const timeA = a.rawDate ? new Date(a.rawDate).getTime() : Number.POSITIVE_INFINITY;
      const timeB = b.rawDate ? new Date(b.rawDate).getTime() : Number.POSITIVE_INFINITY;
      return timeA - timeB;
    });
  }

  function parseUpstreamErrorDetail(detail) {
    const raw = String(detail || '').trim();
    if (!raw) return null;
    if (!raw.startsWith('{')) return raw;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return String(parsed.error || parsed.message || parsed.details || raw);
      }
    } catch {
      return raw;
    }
    return raw;
  }

  function formatRosterErrorMessage(error) {
    if (isFetchAborted(error)) {
      return '';
    }

    let msg = String(error?.message || '').trim();
    if (/aborted/i.test(msg)) {
      return '';
    }
    msg = parseUpstreamErrorDetail(msg) || msg;

    if (window.location.protocol === 'file:') {
      return 'Ouvrez le dashboard via un serveur HTTP local (Live Server, Vercel). file:// bloque les appels API.';
    }

    if (/service unavailable|upstream http error|upstream timeout|upstream error/i.test(msg)) {
      return PLANNING_UPSTREAM_ERROR_MESSAGE;
    }
    const httpStatusMatch = msg.match(/\bHTTP (5\d{2})\b/);
    if (httpStatusMatch) {
      return httpStatusMatch[1] === '503'
        ? PLANNING_UPSTREAM_ERROR_MESSAGE
        : PLANNING_SERVER_ERROR_MESSAGE;
    }
    if (/\b503\b/.test(msg)) {
      return PLANNING_UPSTREAM_ERROR_MESSAGE;
    }
    if (/^HTTP 404\b/.test(msg) || msg.includes('HTTP 404')) {
      return 'Erreur de synchronisation avec la base de données';
    }
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return 'Impossible de charger le planning. Mode hors-ligne';
    }
    if (/réponse vide|respond to webhook|webhook not registered/i.test(msg)) {
      return 'Aucun rendez-vous trouvé.';
    }
    if (msg.startsWith('{') && msg.includes('"error"')) {
      return PLANNING_SERVER_ERROR_MESSAGE;
    }
    if (msg && msg.length <= 160) {
      return msg;
    }
    return 'Impossible de charger le planning. Mode hors-ligne';
  }

  /**
   * Normalize one roster row — Postgres snake_case first, legacy aliases last.
   */
  function firstPresent(...values) {
    for (const value of values) {
      if (value == null || value === '') continue;
      return value;
    }
    return undefined;
  }

  function normalizeRosterRecord(raw) {
    const item = raw?.json && typeof raw.json === 'object' && !Array.isArray(raw.json)
      ? raw.json
      : raw;

    if (!item || typeof item !== 'object') return null;

    const patientName = firstPresent(
      item.patient_name,
      item.name,
      item.Nom,
      item.nom,
      item.Clean_Name,
      item['Patient (Nom Complet)']
    ) ?? 'Non spécifié';

    const rawDate = firstPresent(
      item.starts_at,
      item.startTime,
      item.start_time,
      item.datetime,
      item.date,
      item['Date & Heure du RDV']
    );

    const treatment = firstPresent(
      item.treatment_name,
      item.treatment,
      item.motif,
      item['Motif de Consultation']
    ) ?? 'Consultation';

    const statusRaw = firstPresent(
      item.status,
      item.statut,
      item['Statut du RDV']
    );
    const status = String(statusRaw || 'Confirmé').trim() || 'Confirmé';

    const calBookingId = String(
      firstPresent(item.cal_booking_uid, item.calBookingId, item['Cal Booking ID']) || ''
    ).trim();

    const phone = String(
      firstPresent(item.patient_phone, item.phone, item.telephone, item['Téléphone (WhatsApp)']) || ''
    ).trim();

    const email = String(firstPresent(item.email, item['Email Contact']) || '').trim();

    const observations = String(
      firstPresent(item.notes, item.observations, item['Observations Médicales']) || ''
    ).trim();

    const coverage = String(
      firstPresent(item.coverage, item.insurance, item['Couverture Médicale']) || ''
    ).trim();

    const billingStatus = String(
      firstPresent(item.billingStatus, item.statutFacturation, item['Statut Facturation']) || ''
    ).trim();

    const isNewPatient = parseNewPatientFlag(
      firstPresent(
        item.isNewPatient,
        item.newPatient,
        item['Nouveau Patient ?'],
        item['Nouveau Patient']
      )
    );

    const practitioner = String(
      firstPresent(item.practitioner, item['Praticien Assigné'], item['Praticien']) || ''
    ).trim();

    const bookingId = parseBookingRowId(
      item.id ?? item.ID ?? item.row_id ?? item.rowId
    );

    const id = bookingId ?? `row-${String(patientName)}-${String(rawDate ?? '')}`;

    return {
      id,
      rowId: bookingId,
      name: String(patientName).trim() || 'Non spécifié',
      treatment: String(treatment).trim() || 'Consultation',
      status,
      calBookingId,
      phone,
      email,
      observations,
      coverage,
      insurance: coverage,
      billingStatus,
      isNewPatient,
      practitioner,
      time: formatAppointmentTime(rawDate),
      rawDate,
      noShow: Boolean(
        item.noShow ??
        item['Historique No-Show'] ??
        item['Historique de no-shows']
      ),
      starts_at: rawDate,
      duration_min: Number(item.duration_min || item.durationMin) || 30,
      booking_kind: item.booking_kind || item.bookingKind || 'visit',
      care_started_at: item.care_started_at || item.careStartedAt || null,
      cancel_reason: item.cancel_reason || item.cancelReason || null,
      noshow_90d: Number(item.noshow_90d) || 0,
    };
  }

  function updateRosterStats(data) {
    const total = data.length;
    const confirmed = data.filter(a => a.status === 'Confirmé').length;
    const waiting = data.filter(a => a.status === 'En salle d\'attente').length;

    const countEl = $('roster-count');
    if (countEl) countEl.textContent = String(total);
    const confirmedEl = $('roster-confirmed');
    if (confirmedEl) confirmedEl.textContent = String(confirmed);
    const waitingEl = $('roster-waiting');
    if (waitingEl) waitingEl.textContent = String(waiting);
  }

  function buildNoShowFlag() {
    return `<span class="roster-noshow-flag" title="Historique de no-shows. Vigilance recommandée" aria-label="Historique de no-shows">${NOSHOW_SVG}</span>`;
  }

  function applyMatteSelectSkin(selectEl, status) {
    if (!selectEl) return;
    selectEl.dataset.matte = getMatteChipModifier(status ?? selectEl.value);
  }

  function updateStatusDotForSelect(selectEl) {
    const wrap = selectEl.closest('.status-control');
    const dot = wrap?.querySelector('.status-dot');
    if (!dot) return;
    dot.className = `status-dot status-dot--${getMatteChipModifier(selectEl.value)}`;
    dot.title = selectEl.value;
    dot.setAttribute('aria-label', selectEl.value);
  }

  function parseNewPatientFlag(raw) {
    if (raw === true || raw === 1) return true;
    const value = extractScalarValue(raw) || raw;
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    if (!normalized) return false;
    return normalized === 'oui'
      || normalized === 'yes'
      || normalized === 'true'
      || normalized === '1'
      || normalized === 'nouveau';
  }

  function isUnpaidBillingStatus(status) {
    const normalized = String(status ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    return normalized.includes('non') && normalized.includes('paye');
  }

  function getBillingStatusPillClass(status) {
    const normalized = String(status ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    if (normalized.includes('non') && normalized.includes('paye')) {
      return 'status-pill--billing-unpaid';
    }
    if (normalized.includes('paye') && !normalized.includes('non')) {
      return 'status-pill--billing-paid';
    }
    return 'status-pill--neutral';
  }

  function parseAppointmentMinutes(timeStr) {
    const match = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  }

  function isAppointmentPast(record) {
    const appointmentMins = parseAppointmentMinutes(record.time);
    if (appointmentMins == null) return false;
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    return appointmentMins < nowMins;
  }

  const ROW_ACTION_SVG = {
    edit: lucideIcon('pencil', 'icon-sm'),
    sms: lucideIcon('message-square', 'icon-sm'),
    copy: lucideIcon('copy', 'icon-sm'),
    menu: lucideIcon('ellipsis-vertical', 'icon-sm'),
  };

  function createRowActionButton(action, label, svgMarkup, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-action-btn';
    btn.dataset.action = action;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = svgMarkup;
    window.refreshLucideIcons?.(btn);
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick(event);
    });
    return btn;
  }

  function copyTextToClipboard(text, sourceEl) {
    const value = String(text || '').trim();
    if (!value || value === '—') {
      showToast('Aucun numéro à copier.', 'warning');
      return;
    }
    if (sourceEl?.classList?.contains('copyable')) {
      kineticCopyFeedback(sourceEl, value);
      return;
    }
    navigator.clipboard?.writeText(value)
      .then(() => showToast('Numéro copié dans le presse-papiers.', 'success'))
      .catch(() => showToast('Copie impossible. Sélectionnez le numéro manuellement.', 'error'));
  }

  async function sendQuickSmsToRow(rowId) {
    const parsed = parseBookingRowId(rowId);
    if (parsed == null) {
      showToast('SMS rapide indisponible pour cette ligne.', 'warning');
      return;
    }
    try {
      const result = await postBulkAction(CONFIG.ENDPOINTS.BULK_SMS, { rowIds: [parsed] });
      toastFromSmsResult(result);
    } catch (error) {
      console.error('[Quick SMS] Failed:', error?.message || error);
      showToast('Échec de l\'envoi SMS.', 'error');
    }
  }

  function prefillWaitlistFormFromRow(appt) {
    const nameEl = $('waitlist-name');
    const phoneEl = $('waitlist-phone');
    const priorityEl = getWaitlistPriorityInput();
    if (nameEl) nameEl.value = appt.name || '';
    if (phoneEl) phoneEl.value = appt.phone || appt.telephone || '';
    if (appt.priorite) {
      if (setWaitlistPriorityValue) setWaitlistPriorityValue(appt.priorite);
      else if (priorityEl) priorityEl.value = appt.priorite;
    }
  }

  function createPopoverMenuItem(label, iconSvg, onClick, options = {}) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'actions-popover__item';
    if (options.danger) item.classList.add('actions-popover__item--danger');
    if (options.disabled) {
      item.classList.add('v-disabled');
      item.disabled = true;
    }
    item.setAttribute('role', 'menuitem');
    item.innerHTML = `${iconSvg}<span>${escapeHtml(label)}</span>`;
    window.refreshLucideIcons?.(item);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      if (item.disabled) return;
      onClick(event);
      const root = item.closest('[data-popover-root]');
      const popover = root?.querySelector('.actions-popover');
      const trigger = root?.querySelector('.btn-row-menu, .btn-icon-menu, .btn-account-menu');
      closeActionsPopover(popover, trigger);
    });
    return item;
  }

  function createRowActionsMenu(context) {
    const root = document.createElement('div');
    root.className = 'row-actions-menu';
    root.dataset.popoverRoot = '';

    const popoverId = `row-menu-${Math.random().toString(36).slice(2, 9)}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-row-menu';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', popoverId);
    btn.setAttribute('aria-label', 'Actions');
    btn.innerHTML = ROW_ACTION_SVG.menu;
    window.refreshLucideIcons?.(btn);

    const popover = document.createElement('div');
    popover.className = 'actions-popover row-actions-popover';
    popover.id = popoverId;
    popover.hidden = true;
    popover.setAttribute('role', 'menu');

    const phone = context.phone || context.telephone || context.record?.phone || '';

    if (context.kind === 'waitlist') {
      popover.append(
        createPopoverMenuItem('Modifier le patient', ROW_ACTION_SVG.edit, () => {
          prefillWaitlistFormFromRow(context.appt || context);
          if (VIEW_MAP.waitlist) navigateToView('waitlist');
          $('waitlist-name')?.focus();
        }),
        createPopoverMenuItem('Envoyer un SMS', ROW_ACTION_SVG.sms, () => {
          showToast('Notification SMS planifiée.', 'info');
        }),
        createPopoverMenuItem('Copier le numéro', ROW_ACTION_SVG.copy, () => {
          copyTextToClipboard(phone);
        })
      );
      root.append(btn, popover);
      return root;
    }

    const record = context.record || {};
    const rowId = extractBookingRowId(record);

    popover.append(
      createPopoverMenuItem('Modifier le statut', ROW_ACTION_SVG.edit, () => {
        const row = document.querySelector(`[data-patient-id="${String(record.id)}"] .status-select`);
        row?.focus();
      }),
      createPopoverMenuItem('Envoyer un SMS', ROW_ACTION_SVG.sms, () => {
        if (rowId != null) sendQuickSmsToRow(rowId);
        else showToast('SMS rapide indisponible pour ce rendez-vous.', 'warning');
      }),
      createPopoverMenuItem('Copier les infos', ROW_ACTION_SVG.copy, () => {
        copyTextToClipboard(`${record.name || ''} · ${record.time || ''}`.trim());
      })
    );

    root.append(btn, popover);
    return root;
  }

  function createRowActionGroup(context) {
    return createRowActionsMenu(context);
  }

  if (window.DentaFlowRowUI) {
    window.DentaFlowRowUI.createRowActionGroup = createRowActionGroup;
  }

  let progressiveDisclosureInitialized = false;
  const openPopovers = new Set();
  const popoverDockParents = new WeakMap();
  let popoverClickBound = false;
  let popoverRepositionBound = false;
  let popoverRepositionRaf = null;

  function getPopoverDock(popover) {
    let dock = popoverDockParents.get(popover);
    if (!dock && popover.parentElement && popover.parentElement !== document.body) {
      dock = popover.parentElement;
      popoverDockParents.set(popover, dock);
    }
    return dock;
  }

  function positionActionsPopover(popover, trigger) {
    if (!popover || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    const isDropUp = popover.classList.contains('account-menu-popover')
      || popover.classList.contains('actions-popover--drop-up');

    popover.style.left = 'auto';
    popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;

    if (isDropUp) {
      popover.style.top = 'auto';
      popover.style.bottom = `${window.innerHeight - rect.top + gap}px`;
      popover.style.transformOrigin = 'bottom right';
    } else {
      popover.style.bottom = 'auto';
      popover.style.top = `${rect.bottom + gap}px`;
      popover.style.transformOrigin = 'top right';
    }
  }

  function portalActionsPopover(popover) {
    if (!popover || popover.parentElement === document.body) return;
    getPopoverDock(popover);
    document.body.appendChild(popover);
    popover.classList.add('is-portaled');
  }

  function dockActionsPopover(popover) {
    if (!popover) return;
    const dock = popoverDockParents.get(popover);
    if (dock && popover.parentElement === document.body) {
      dock.appendChild(popover);
    }
    popover.classList.remove('is-portaled');
    popover.style.top = '';
    popover.style.right = '';
    popover.style.left = '';
    popover.style.bottom = '';
  }

  function schedulePopoverReposition() {
    if (!openPopovers.size) return;
    if (popoverRepositionRaf) return;
    popoverRepositionRaf = requestAnimationFrame(() => {
      popoverRepositionRaf = null;
      openPopovers.forEach((popover) => {
        const trigger = document.querySelector(`[aria-controls="${popover.id}"]`);
        if (trigger) positionActionsPopover(popover, trigger);
      });
    });
  }

  function bindPopoverReposition() {
    if (popoverRepositionBound) return;
    popoverRepositionBound = true;
    window.addEventListener('resize', schedulePopoverReposition, { passive: true });
    window.addEventListener('scroll', schedulePopoverReposition, { passive: true, capture: true });
  }

  function closeActionsPopover(popover, trigger) {
    if (!popover) return;

    const finish = () => {
      popover.classList.remove('is-open', 'is-portaled');
      popover.hidden = true;
      popover.style.pointerEvents = 'none';
      popover.style.opacity = '';
      popover.style.transform = '';
      popover.style.top = '';
      popover.style.right = '';
      popover.style.left = '';
      popover.style.bottom = '';
      if (typeof gsap !== 'undefined') {
        gsap.set(popover, { clearProps: 'opacity,transform,pointerEvents' });
      }
      dockActionsPopover(popover);
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      openPopovers.delete(popover);
    };

    if (typeof gsap === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }

    gsap.killTweensOf(popover);
    gsap.to(popover, {
      opacity: 0,
      scale: 0.95,
      duration: 0.12,
      ease: 'power2.in',
      onComplete: finish,
    });
  }

  function openActionsPopover(popover, trigger) {
    if (!popover || !trigger) return;

    openPopovers.forEach((open) => {
      if (open !== popover) {
        const otherTrigger = document.querySelector(`[aria-controls="${open.id}"]`);
        closeActionsPopover(open, otherTrigger);
      }
    });

    bindPopoverReposition();
    portalActionsPopover(popover);
    positionActionsPopover(popover, trigger);
    popover.hidden = false;
    popover.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    openPopovers.add(popover);

    if (typeof gsap === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      popover.style.opacity = '1';
      popover.style.transform = 'scale(1)';
      popover.style.pointerEvents = 'auto';
      return;
    }

    gsap.killTweensOf(popover);
    gsap.fromTo(
      popover,
      { opacity: 0, scale: 0.95, pointerEvents: 'none' },
      { opacity: 1, scale: 1, duration: 0.15, ease: 'power2.out', pointerEvents: 'auto' }
    );
  }

  function initActionsPopovers() {
    if (!popoverClickBound) {
      popoverClickBound = true;

      document.addEventListener('click', (event) => {
        const trigger = event.target.closest('.btn-icon-menu, .btn-row-menu, .btn-account-menu');
        if (trigger) {
          const root = trigger.closest('[data-popover-root]');
          const popover = root?.querySelector('.actions-popover');
          if (popover) {
            event.stopPropagation();
            const isOpen = popover.classList.contains('is-open');
            if (isOpen) closeActionsPopover(popover, trigger);
            else openActionsPopover(popover, trigger);
            return;
          }
        }

        if (event.target.closest('[data-popover-root]')) return;
        openPopovers.forEach((popover) => {
          const triggerEl = document.querySelector(`[aria-controls="${popover.id}"]`);
          closeActionsPopover(popover, triggerEl);
        });
      });

      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        openPopovers.forEach((popover) => {
          const trigger = document.querySelector(`[aria-controls="${popover.id}"]`);
          closeActionsPopover(popover, trigger);
        });
      });
    }
  }

  function animateRowActionGroup(group, show) {
    if (!group || typeof gsap === 'undefined') {
      if (group) {
        group.style.opacity = show ? '1' : '0';
        group.style.transform = show ? 'translateY(0)' : 'translateY(4px)';
        group.style.pointerEvents = show ? 'auto' : 'none';
      }
      return;
    }

    gsap.killTweensOf(group);
    if (show) {
      gsap.to(group, {
        opacity: 1,
        y: 0,
        duration: 0.2,
        ease: 'power2.out',
        onStart: () => { group.style.pointerEvents = 'auto'; },
      });
    } else {
      gsap.to(group, {
        opacity: 0,
        y: 4,
        duration: 0.15,
        ease: 'power2.in',
        onComplete: () => { group.style.pointerEvents = 'none'; },
      });
    }
  }

  function initAccountCardMenu() {
    $('account-menu-settings')?.addEventListener('click', () => {
      if (VIEW_MAP.settings) navigateToView('settings');
    });
    $('account-menu-logout')?.addEventListener('click', (event) => {
      event.preventDefault();
      void askConfirm('Se déconnecter ?').then((ok) => {
        if (ok) void window.DentaFlowAuth?.logout?.();
      });
    });
    $('mobile-logout-btn')?.addEventListener('click', (event) => {
      event.preventDefault();
      void askConfirm('Se déconnecter ?').then((ok) => {
        if (ok) void window.DentaFlowAuth?.logout?.();
      });
    });
  }

  function initRowActionHover() {
    /* Row actions now use persistent triple-dot menus — hover reveal disabled. */
  }

  function initMatteButtonPress() {
    if (typeof gsap === 'undefined') return;

    const resetScale = (btn) => {
      gsap.to(btn, { scale: 1, duration: 0.12, ease: 'power2.out' });
    };

    document.addEventListener('mousedown', (event) => {
      const btn = event.target.closest('.btn-matte-primary');
      if (!btn || btn.disabled) return;
      gsap.to(btn, { scale: 0.97, duration: 0.1, ease: 'power2.out' });
    });

    document.addEventListener('mouseup', (event) => {
      const btn = event.target.closest('.btn-matte-primary');
      if (btn) resetScale(btn);
    });

    document.addEventListener('mouseleave', (event) => {
      const btn = event.target.closest?.('.btn-matte-primary');
      if (btn) resetScale(btn);
    }, true);
  }

  function wireWaitlistAdminPopover() {
    const fillBtn = $('waitlist-popover-fill-gap');
    const exportBtn = $('waitlist-popover-export');

    if (fillBtn && fillBtn.dataset.adminWired !== 'true') {
      fillBtn.dataset.adminWired = 'true';
      fillBtn.addEventListener('click', async () => {
      const rosterFill = $('btn-super-fill-gap') || $('btn-fill-gap');
      if (rosterFill) {
        rosterFill.click();
        return;
      }

      const confirmed = await askConfirm('Remplacer le créneau avec un patient de la liste d\'attente ?');
      if (!confirmed) return;

      fillBtn.disabled = true;
      try {
        const response = await fetch(CONFIG.FILL_GAP_PROXY, {
          method: 'POST',
          credentials: 'include',
          headers: apiHeaders(),
          body: JSON.stringify({}),
        });
        assertAuthorizedResponse(response);
        const payload = await response.json();
        if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
        toastFillGapResult(payload);
      } catch {
        showToast('Impossible de consulter la liste d\'attente. Réessayez.', 'error');
      } finally {
        fillBtn.disabled = false;
      }
      });
    }

    if (exportBtn && exportBtn.dataset.adminWired !== 'true') {
      exportBtn.dataset.adminWired = 'true';
      wireDeployingFeatureButton(exportBtn, DEPLOYING_FEATURE_NOTICES.dailyReport);
    }
  }

  /* ── Invisible UI: dynamic tooltips, kinetic copy, inline confirm, notes pulse ── */

  let globalTooltipEl = null;
  let invisibleUIInitialized = false;
  let tooltipTargetEl = null;
  const notesIndicatorTweens = new WeakMap();

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function ensureGlobalTooltip() {
    if (globalTooltipEl?.isConnected) return globalTooltipEl;
    globalTooltipEl = document.getElementById('global-tooltip');
    if (!globalTooltipEl) {
      globalTooltipEl = document.createElement('div');
      globalTooltipEl.id = 'global-tooltip';
      globalTooltipEl.setAttribute('role', 'tooltip');
      globalTooltipEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(globalTooltipEl);
    }
    if (typeof gsap !== 'undefined') {
      gsap.set(globalTooltipEl, { opacity: 0, scale: 0.95 });
    } else {
      globalTooltipEl.style.opacity = '0';
      globalTooltipEl.style.transform = 'scale(0.95)';
    }
    return globalTooltipEl;
  }

  function positionGlobalTooltip(clientX, clientY) {
    const el = globalTooltipEl;
    if (!el) return;
    const offset = 14;
    const rect = el.getBoundingClientRect();
    let left = clientX + offset;
    let top = clientY + offset;
    const maxLeft = window.innerWidth - rect.width - 8;
    const maxTop = window.innerHeight - rect.height - 8;
    if (left > maxLeft) left = Math.max(8, clientX - rect.width - offset);
    if (top > maxTop) top = Math.max(8, clientY - rect.height - offset);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function showGlobalTooltip(text, clientX, clientY) {
    const tip = ensureGlobalTooltip();
    if (!text) return;
    tip.textContent = text;
    tip.classList.add('is-visible');
    tip.setAttribute('aria-hidden', 'false');
    tip.style.pointerEvents = 'none';
    positionGlobalTooltip(clientX, clientY);
    if (typeof gsap === 'undefined' || prefersReducedMotion()) {
      tip.style.opacity = '1';
      tip.style.transform = 'scale(1)';
      return;
    }
    gsap.killTweensOf(tip);
    gsap.to(tip, { opacity: 1, scale: 1, duration: 0.2, ease: 'back.out(1.5)' });
  }

  function hideGlobalTooltip() {
    if (!globalTooltipEl) return;
    tooltipTargetEl = null;
    const tip = globalTooltipEl;
    const finish = () => {
      tip.classList.remove('is-visible');
      tip.setAttribute('aria-hidden', 'true');
      tip.textContent = '';
      tip.style.pointerEvents = 'none';
    };
    if (typeof gsap === 'undefined' || prefersReducedMotion()) {
      tip.style.opacity = '0';
      tip.style.transform = 'scale(0.95)';
      finish();
      return;
    }
    gsap.killTweensOf(tip);
    gsap.to(tip, {
      opacity: 0,
      scale: 0.95,
      duration: 0.15,
      ease: 'power2.in',
      onComplete: finish,
    });
  }

  function initGlobalTooltipEngine() {
    document.addEventListener('mouseover', (event) => {
      const target = event.target.closest('[data-tooltip]');
      if (!target) return;
      const text = target.dataset.tooltip?.trim();
      if (!text) return;
      tooltipTargetEl = target;
      showGlobalTooltip(text, event.clientX, event.clientY);
    });

    document.addEventListener('mousemove', (event) => {
      if (!tooltipTargetEl || !globalTooltipEl) return;
      if (!event.target.closest('[data-tooltip]')) return;
      positionGlobalTooltip(event.clientX, event.clientY);
    });

    document.addEventListener('mouseout', (event) => {
      const from = event.target.closest('[data-tooltip]');
      if (!from) return;
      const related = event.relatedTarget;
      if (related && from.contains(related)) return;
      if (tooltipTargetEl === from) hideGlobalTooltip();
    });

    document.addEventListener('focusin', (event) => {
      const target = event.target.closest('[data-tooltip]');
      if (!target) return;
      const text = target.dataset.tooltip?.trim();
      if (!text) return;
      const rect = target.getBoundingClientRect();
      tooltipTargetEl = target;
      showGlobalTooltip(text, rect.left + rect.width / 2, rect.top);
    });

    document.addEventListener('focusout', (event) => {
      if (event.target.closest('[data-tooltip]')) hideGlobalTooltip();
    });
  }

  function setCopyableField(elementId, value, fallback = 'Non renseigné') {
    const el = $(elementId);
    if (!el) return;
    const raw = String(value || '').trim();
    el.replaceChildren();
    if (raw && raw !== '—' && raw !== 'Non renseigné') {
      el.appendChild(createCopyableSpan(raw));
    } else {
      el.textContent = fallback;
    }
  }

  function kineticCopyFeedback(el, value) {
    const text = String(value || el.dataset.value || '').trim();
    if (!text) {
      showToast('Aucune valeur à copier.', 'warning');
      return;
    }

    const write = navigator.clipboard?.writeText(text);
    const onSuccess = () => {
      if (!el.dataset.originalText) el.dataset.originalText = el.textContent;
      const originalText = el.dataset.originalText;
      el.textContent = 'Copié !';
      el.classList.add('is-copied');
      el.setAttribute('aria-label', 'Copié dans le presse-papiers');

      if (typeof gsap !== 'undefined' && !prefersReducedMotion()) {
        gsap.fromTo(
          el,
          { scale: 1, y: 0 },
          { scale: 1.05, y: -2, duration: 0.15, ease: 'power2.out', yoyo: true, repeat: 1 }
        );
      }

      window.setTimeout(() => {
        el.textContent = originalText;
        el.classList.remove('is-copied');
        el.setAttribute('aria-label', `Copier ${originalText}`);
        if (typeof gsap !== 'undefined' && !prefersReducedMotion()) {
          gsap.to(el, { scale: 1, y: 0, duration: 0.2, ease: 'power2.out' });
        }
      }, 1500);
    };

    if (write?.then) {
      write.then(onSuccess).catch(() => {
        showToast('Copie impossible. Sélectionnez la valeur manuellement.', 'error');
      });
    } else {
      onSuccess();
    }
  }

  function initCopyableInteractions() {
    // Handled by bindCoreDelegation() — kept for API compatibility.
  }

  function safeRender(label, fn) {
    try {
      return fn();
    } catch (error) {
      console.warn(`[DentaFlow] ${label} failed:`, error?.message || error);
      return null;
    }
  }

  let coreDelegationBound = false;

  function bindCoreDelegation() {
    if (coreDelegationBound) return;
    coreDelegationBound = true;

    document.addEventListener('change', handleDelegatedCheckboxChange);

    document.addEventListener('click', (event) => {
      const copyEl = event.target.closest('.copyable');
      if (copyEl) {
        event.preventDefault();
        event.stopPropagation();
        kineticCopyFeedback(copyEl, copyEl.dataset.value);
        return;
      }

      const confirmBtn = event.target.closest('#btn-bulk-confirm');
      if (confirmBtn && !confirmBtn.disabled) {
        event.preventDefault();
        bulkConfirmSelected();
        return;
      }

      const cancelBtn = event.target.closest('#btn-bulk-cancel');
      if (cancelBtn && !cancelBtn.disabled) {
        event.preventDefault();
        bulkCancelSelected();
        return;
      }

      const smsBtn = event.target.closest('#btn-bulk-sms');
      if (smsBtn && !smsBtn.disabled) {
        event.preventDefault();
        bulkSmsSelected();
        return;
      }

      const crmRow = event.target.closest('#crm-table-body .crm-table-row');
      if (crmRow && !crmRow.classList.contains('crm-table-empty')) {
        activateCrmRow(crmRow);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const copyEl = event.target.closest('.copyable');
      if (!copyEl) return;
      event.preventDefault();
      kineticCopyFeedback(copyEl, copyEl.dataset.value);
    });
  }

  function getPatientRowElement(patientId) {
    const id = String(patientId);
    return (
      document.querySelector(`#planning-timeline .timeline-item[data-patient-id="${id}"]`)
      || document.querySelector(`#roster-tbody tr[data-patient-id="${id}"]`)
      || document.querySelector(`#crm-table-body tr[data-patient-id="${id}"]`)
    );
  }

  function animateRowConfirmSuccess(patientId, index = 0) {
    const row = getPatientRowElement(patientId);
    if (!row) return;

    const surface = row.querySelector('.timeline-item__card') || row;
    const statusEl = row.querySelector('.status-select')
      || row.querySelector('.status-pill')
      || row.querySelector('.matte-chip');
    const checkbox = row.querySelector('.row-checkbox');

    row.classList.add('is-confirm-success');

    if (statusEl?.tagName === 'SELECT') {
      statusEl.value = 'Confirmé';
      applyMatteSelectSkin(statusEl, 'Confirmé');
    } else if (statusEl) {
      statusEl.textContent = 'Confirmé';
      statusEl.className = 'status-pill crm-tag--confirmé matte-chip matte-chip--confirmé';
    }

    if (prefersReducedMotion() || typeof gsap === 'undefined') {
      surface.style.borderLeft = '4px solid #34d399';
      surface.style.backgroundColor = 'rgba(52, 211, 153, 0.05)';
      window.setTimeout(() => {
        surface.style.backgroundColor = '';
      }, 1000);
      if (checkbox) checkbox.checked = false;
      return;
    }

    const tl = gsap.timeline({ delay: index * 0.06 });

    if (checkbox?.checked) {
      tl.to(checkbox, {
        opacity: 0,
        scale: 0.8,
        duration: 0.2,
        ease: 'power2.in',
        onComplete: () => {
          checkbox.checked = false;
          gsap.set(checkbox, { clearProps: 'opacity,transform' });
        },
      }, 0);
    }

    tl.fromTo(
      surface,
      { borderLeftWidth: 1, borderLeftColor: 'rgba(255,255,255,0.05)' },
      { borderLeftWidth: 4, borderLeftColor: '#34d399', duration: 0.3, ease: 'power2.out' },
      0
    );

    if (statusEl) {
      tl.fromTo(
        statusEl,
        { scale: 0.92, backgroundColor: 'rgba(255,255,255,0.04)' },
        {
          scale: 1,
          backgroundColor: 'rgba(16, 185, 129, 0.15)',
          color: '#34d399',
          duration: 0.3,
          ease: 'back.out(1.4)',
        },
        0.12
      );
    }

    tl.fromTo(
      surface,
      { backgroundColor: 'rgba(52, 211, 153, 0.05)' },
      { backgroundColor: 'transparent', duration: 1, ease: 'sine.out' },
      0.2
    );
  }

  function animateInlineConfirmSuccess(patientIds) {
    const ids = Array.isArray(patientIds) ? patientIds.map(String) : [];
    if (!ids.length) return;

    const btnConfirm = $('btn-bulk-confirm');
    if (btnConfirm && typeof gsap !== 'undefined' && !prefersReducedMotion()) {
      gsap.to(btnConfirm, {
        opacity: 0,
        scale: 0.8,
        duration: 0.2,
        ease: 'power2.in',
        onComplete: () => {
          gsap.set(btnConfirm, { clearProps: 'opacity,transform' });
        },
      });
    }

    ids.forEach((id, index) => animateRowConfirmSuccess(id, index));
  }

  function pulseNotesIndicators(scope = document) {
    scope.querySelectorAll('.notes-indicator').forEach((indicator) => {
      if (notesIndicatorTweens.has(indicator)) return;
      if (prefersReducedMotion() || typeof gsap === 'undefined') return;
      gsap.set(indicator, { opacity: 1 });
      const tween = gsap.to(indicator, {
        opacity: 0.4,
        duration: 2,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inOut',
      });
      notesIndicatorTweens.set(indicator, tween);
    });
  }

  function hydrateStaticCrmTableRows() {
    document.querySelectorAll('#crm-table-body .crm-table-row').forEach((row) => {
      const obs = String(row.dataset.observations || '').trim();
      const nameCell = row.cells?.[0];
      const phoneCell = row.cells?.[1];

      if (nameCell && obs && !nameCell.querySelector('.notes-indicator')) {
        nameCell.classList.add('has-notes');
        const indicator = document.createElement('span');
        indicator.className = 'notes-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        indicator.dataset.tooltip = 'Notes internes disponibles';
        nameCell.appendChild(indicator);
      }

      if (phoneCell && !phoneCell.querySelector('.copyable')) {
        const phone = String(row.dataset.phone || phoneCell.textContent || '').trim();
        phoneCell.replaceChildren();
        if (phone) phoneCell.appendChild(createCopyableSpan(phone));
        else phoneCell.textContent = 'Non renseigné';
      }
    });
  }

  function refreshInvisibleUIDecorations(root) {
    const scope = !root || root === document ? document : root;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;

    scope.querySelectorAll('.row-action-btn[aria-label]:not([data-tooltip])').forEach((btn) => {
      const label = btn.getAttribute('aria-label');
      if (label) btn.dataset.tooltip = label;
    });

    scope.querySelectorAll('.cell-truncate[title]:not([data-tooltip])').forEach((el) => {
      const title = el.getAttribute('title');
      if (title) {
        el.dataset.tooltip = title;
        el.removeAttribute('title');
      }
    });

    if (!root || root === document) hydrateStaticCrmTableRows();
    pulseNotesIndicators(scope);
  }

  function initInvisibleUI() {
    if (invisibleUIInitialized) {
      refreshInvisibleUIDecorations();
      return;
    }
    invisibleUIInitialized = true;
    ensureGlobalTooltip();
    initGlobalTooltipEngine();
    refreshInvisibleUIDecorations();
  }

  function initProgressiveDisclosure() {
    initActionsPopovers();
    if (!progressiveDisclosureInitialized) {
      progressiveDisclosureInitialized = true;
      initRowActionHover();
      initMatteButtonPress();
    }
    wireWaitlistAdminPopover();

    document.querySelectorAll('[data-popover-root] .actions-popover__item').forEach((item) => {
      if (item.dataset.popoverItemBound === 'true') return;
      item.dataset.popoverItemBound = 'true';
      item.addEventListener('click', () => {
        const root = item.closest('[data-popover-root]');
        const popover = root?.querySelector('.actions-popover');
        const trigger = root?.querySelector('.btn-icon-menu');
        closeActionsPopover(popover, trigger);
      });
    });
  }

  function buildStatusSelect(record) {
    const currentStatus = STATUS_OPTIONS.includes(record.status) ? record.status : 'Confirmé';
    const options = STATUS_OPTIONS.map(opt =>
      `<option value="${escapeHtml(opt)}"${opt === currentStatus ? ' selected' : ''}>${escapeHtml(opt)}</option>`
    ).join('');
    return `<select class="status-select" aria-label="Modifier le statut" data-booking-id="${escapeHtml(getBookingIdForApi(record) || '')}">${options}</select>`;
  }

  function createStatusSelectElement(record) {
    const wrap = document.createElement('div');
    wrap.className = 'status-control';

    const currentStatus = STATUS_OPTIONS.includes(record.status) ? record.status : 'Confirmé';
    wrap.appendChild(createStatusDot(currentStatus));

    const select = document.createElement('select');
    select.className = 'status-select status-select--ghost';
    select.setAttribute('aria-label', 'Modifier le statut');
    const recordId = getBookingIdForApi(record);
    if (recordId) {
      select.dataset.bookingId = recordId;
    }
    STATUS_OPTIONS.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      if (opt === currentStatus) option.selected = true;
      select.appendChild(option);
    });
    applyMatteSelectSkin(select, currentStatus);
    select.addEventListener('change', () => updateStatusDotForSelect(select));
    wrap.appendChild(select);
    return wrap;
  }

  function createPlanningTimelineItem(record) {
    const patientId = String(record.id);
    const bookingRowId = extractBookingRowId(record);
    const scheduleDate = formatScheduleDate(record.rawDate);

    const item = document.createElement('article');
    item.className = 'timeline-item';
    item.setAttribute('role', 'listitem');
    item.dataset.patientId = patientId;
    item.dataset.id = patientId;
    if (scheduleDate) item.dataset.scheduleDate = scheduleDate;
    if (record.time) item.dataset.startTime = String(record.time);
    if (record.practitioner) item.dataset.practitioner = String(record.practitioner);
    if (record.calBookingId) item.dataset.calBookingId = String(record.calBookingId);
    if (record.status === 'No-show') item.classList.add('is-cancelled');
    if (isAppointmentPast(record)) item.classList.add('timeline-item--past');

    const timeEl = document.createElement('div');
    timeEl.className = 'timeline-item__time';
    timeEl.textContent = record.time || '';

    const rail = document.createElement('div');
    rail.className = 'timeline-item__rail';
    const node = document.createElement('span');
    node.className = 'timeline-item__node';
    node.setAttribute('aria-hidden', 'true');
    rail.appendChild(node);

    const card = document.createElement('div');
    card.className = 'timeline-item__card';
    card.dataset.rowInteractive = 'true';

    const checkboxWrap = document.createElement('div');
    checkboxWrap.className = 'timeline-item__checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'brutalist-checkbox row-checkbox';
    if (bookingRowId != null) {
      checkbox.dataset.rowId = String(bookingRowId);
      checkbox.value = String(bookingRowId);
      checkbox.setAttribute('aria-label', `Sélectionner ${record.name}`);
    } else {
      checkbox.disabled = true;
    }
    checkboxWrap.appendChild(checkbox);

    const main = document.createElement('div');
    main.className = 'timeline-item__main';
    main.appendChild(createPatientIdentity(record.name, {
      showNoShow: record.noShow,
      hasNotes: Boolean(String(record.observations || '').trim()),
      isNewPatient: Boolean(record.isNewPatient),
    }));

    const treatment = document.createElement('div');
    treatment.className = 'timeline-item__treatment cell-truncate';
    treatment.textContent = record.treatment || '';
    if (record.treatment) treatment.dataset.tooltip = record.treatment;
    main.appendChild(treatment);

    const meta = document.createElement('div');
    meta.className = 'timeline-item__meta';

    const statusWrap = document.createElement('div');
    statusWrap.className = 'timeline-item__status';
    statusWrap.appendChild(createStatusSelectElement(record));

    meta.appendChild(statusWrap);
    meta.appendChild(createRowActionGroup({ kind: 'planning', record }));
    card.append(checkboxWrap, main, meta);
    item.append(timeEl, rail, card);
    return item;
  }

  /** @deprecated Legacy table row — kept for backward compatibility */
  function createRosterTableRow(record) {
    const patientId = String(record.id);
    const bookingRowId = extractBookingRowId(record);
    const scheduleDate = formatScheduleDate(record.rawDate);

    const tr = document.createElement('tr');
    tr.dataset.patientId = patientId;
    tr.dataset.id = patientId;
    if (scheduleDate) tr.dataset.scheduleDate = scheduleDate;
    if (record.time) tr.dataset.startTime = String(record.time);
    if (record.practitioner) tr.dataset.practitioner = String(record.practitioner);
    if (record.calBookingId) tr.dataset.calBookingId = String(record.calBookingId);
    if (record.status === 'No-show') tr.classList.add('is-cancelled');

    const checkCell = document.createElement('td');
    checkCell.className = 'roster-checkbox-cell';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'brutalist-checkbox row-checkbox';
    if (bookingRowId != null) {
      checkbox.dataset.rowId = String(bookingRowId);
      checkbox.value = String(bookingRowId);
      checkbox.setAttribute('aria-label', `Sélectionner ${record.name}`);
    } else {
      checkbox.disabled = true;
    }
    checkCell.appendChild(checkbox);

    const timeCell = document.createElement('td');
    timeCell.className = 'roster-time';
    timeCell.textContent = record.time || '';

    const patientCell = document.createElement('td');
    const patientWrap = document.createElement('span');
    patientWrap.className = 'roster-patient';
    if (record.noShow) {
      const flagSpan = document.createElement('span');
      flagSpan.className = 'roster-noshow-flag';
      flagSpan.title = 'Historique de no-shows. Vigilance recommandée';
      flagSpan.setAttribute('aria-label', 'Historique de no-shows');
      flagSpan.innerHTML = NOSHOW_SVG;
      patientWrap.appendChild(flagSpan);
    }
    const nameSpan = document.createElement('span');
    nameSpan.className = 'roster-patient__name';
    nameSpan.textContent = record.name || '';
    patientWrap.appendChild(nameSpan);
    if (record.isNewPatient) {
      const badge = document.createElement('span');
      badge.className = 'patient-new-badge';
      badge.setAttribute('aria-label', 'Nouveau patient');
      const dot = document.createElement('span');
      dot.className = 'patient-new-badge__dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'patient-new-badge__label';
      label.textContent = 'Nouveau Patient';
      badge.append(dot, label);
      patientWrap.appendChild(badge);
    }
    patientCell.appendChild(patientWrap);

    const treatmentCell = document.createElement('td');
    treatmentCell.className = 'roster-treatment';
    treatmentCell.textContent = record.treatment || '';

    const statusCell = document.createElement('td');
    statusCell.appendChild(createStatusSelectElement(record));

    tr.append(checkCell, timeCell, patientCell, treatmentCell, statusCell);
    return tr;
  }

  function createRosterCard(record) {
    const patientId = String(record.id);
    const article = document.createElement('article');
    article.className = `roster-card${record.status === 'No-show' ? ' is-cancelled' : ''}`;
    article.dataset.patientId = patientId;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'roster-time';
    timeSpan.textContent = record.time || '';

    const main = document.createElement('div');
    main.className = 'roster-card__main';
    main.appendChild(createPatientIdentity(record.name, {
      showNoShow: record.noShow,
      isNewPatient: Boolean(record.isNewPatient),
    }));

    const meta = document.createElement('div');
    meta.className = 'roster-card__meta cell-truncate';
    meta.textContent = record.treatment || '';
    if (record.treatment) meta.title = record.treatment;

    main.appendChild(meta);
    article.append(timeSpan, main, createStatusSelectElement(record));
    return article;
  }

  function createOverviewTimelineCard(record) {
    const card = document.createElement('article');
    card.className = `timeline-card timeline-card--${getMatteChipModifier(record.status)}`;
    card.setAttribute('role', 'listitem');

    const timeCol = document.createElement('div');
    timeCol.className = 'timeline-card__time';
    timeCol.textContent = record.time || '';

    const infoCol = document.createElement('div');
    infoCol.className = 'timeline-card__info';

    const nameEl = document.createElement('p');
    nameEl.className = 'timeline-card__name';
    nameEl.textContent = record.name || 'Non spécifié';

    const reasonEl = document.createElement('p');
    reasonEl.className = 'timeline-card__reason';
    reasonEl.textContent = record.treatment || 'Consultation';

    infoCol.append(nameEl, reasonEl);

    const statusCol = document.createElement('div');
    statusCol.className = 'timeline-card__status';
    const badge = document.createElement('span');
    badge.className = 'timeline-card__badge';
    badge.textContent = record.status || 'Confirmé';
    statusCol.appendChild(badge);

    card.append(timeCol, infoCol, statusCol);
    return card;
  }

  function renderOverviewTimeline(rosterData) {
    const container = document.getElementById('overview-timeline-container');
    if (!container) return;

    container.replaceChildren();
    const rows = Array.isArray(rosterData) ? rosterData.filter(Boolean) : [];

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-timeline';
      empty.textContent = 'Aucun rendez-vous planifié aujourd\'hui.';
      container.appendChild(empty);
      return;
    }

    const sorted = sortRosterByTime([...rows]);
    const fragment = document.createDocumentFragment();
    sorted.forEach((record) => fragment.appendChild(createOverviewTimelineCard(record)));
    container.appendChild(fragment);
  }

  function renderPlanning(records) {
    return safeRender('renderPlanning', () => {
    const incoming = Array.isArray(records) ? records.filter(Boolean) : [];
    renderHoldStrip(incoming);
    const rows = incoming.filter(isVisitBooking);

    rosterData = rows.map(record => ({ ...record }));
    selectedPatientIds = [];

    updateRosterStats(rosterData);

    const emptyMessage = EMPTY_STATE_DEFAULT_MESSAGE;

    const timeline = $('planning-timeline');
    if (timeline) {
      timeline.replaceChildren();
      if (!rows.length) {
        clearEmptyState('planning-empty-state');
        mountEmptyState('planning-empty-state', { message: emptyMessage });
      } else {
        clearEmptyState('planning-empty-state');
        const fragment = document.createDocumentFragment();
        rows.forEach((record) => fragment.appendChild(createPlanningTimelineItem(record)));
        timeline.appendChild(fragment);
      }
    }

    refreshInvisibleUIDecorations(timeline);

    const tbody = $('roster-tbody');
    if (tbody) {
      tbody.replaceChildren();
      if (!rows.length) {
        const emptyRow = document.createElement('tr');
        emptyRow.className = 'roster-empty';
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.textContent = emptyMessage;
        emptyRow.appendChild(cell);
        tbody.appendChild(emptyRow);
      } else {
        const fragment = document.createDocumentFragment();
        rows.forEach((record) => fragment.appendChild(createRosterTableRow(record)));
        tbody.appendChild(fragment);
      }
    }

    updateBulkBarUI();

    const cards = $('roster-cards');
    if (cards) {
      cards.replaceChildren();
      if (!rows.length) {
        const empty = createEmptyState({ message: emptyMessage });
        empty.classList.add('roster-cards__empty');
        cards.appendChild(empty);
        initEmptyStatePulse(empty);
      } else {
        const fragment = document.createDocumentFragment();
        rows.forEach((record) => fragment.appendChild(createRosterCard(record)));
        cards.appendChild(fragment);
      }
    }

    if (activeView === 'overview' && osBootSequencePlayed) {
      restartViewStaggerAnimations($('view-overview'));
    }

    renderCRMTable(rows);
    if (rows.length) {
      updateCRMSidePanel(toCrmPatient(rows[0]));
    }

    renderOperationalPulse(computeOperationalPulse(rows));
    renderLateList(rows);
    renderStatusBoard(rows);
    refreshHandoffBookingOptions(rows);
    void loadRecallStrip();
    refreshInvisibleUIDecorations($('assistant-pulse-grid'));
    renderOverviewTimeline(rows);
    window.refreshLucideIcons?.(document.getElementById('assistant-mount') || document);
    hideSkeleton('roster');
    hideSkeleton('crm');
    });
  }

  function showTableLoader() {
    showSkeleton('roster');
    showSkeleton('crm');
  }

  function showTableError(message = 'Impossible de charger le planning. Mode hors-ligne') {
    hideSkeleton('roster');
    hideSkeleton('crm');
    const friendlyMessage = typeof message === 'string' && message.includes('Erreur de connexion au serveur')
      ? message
      : formatRosterErrorMessage({ message });

    if (!friendlyMessage || /aborted/i.test(friendlyMessage)) {
      return;
    }

    const timeline = $('planning-timeline');
    if (timeline) {
      timeline.replaceChildren();
      const emptyState = document.createElement('div');
      emptyState.className = 'planning-empty-state';
      const paragraph = document.createElement('p');
      paragraph.textContent = friendlyMessage;
      emptyState.appendChild(paragraph);
      timeline.appendChild(emptyState);
    }

    clearEmptyState('planning-empty-state');

    const tbody = $('roster-tbody');
    if (tbody) {
      tbody.replaceChildren();
      const tr = document.createElement('tr');
      tr.className = 'roster-error';
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = friendlyMessage;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    const cards = $('roster-cards');
    if (cards) {
      cards.replaceChildren();
      const errorP = document.createElement('p');
      errorP.className = 'roster-cards__error';
      errorP.textContent = friendlyMessage;
      cards.appendChild(errorP);
    }

    updateRosterStats([]);
    renderOperationalPulse(createEmptyOperationalPulse());
    renderLateList([]);
    renderStatusBoard([]);
    refreshHandoffBookingOptions([]);
    refreshInvisibleUIDecorations($('assistant-pulse-grid'));
    setSyncIndicator('error');
  }

  async function fetchRosterPayload(url) {
    await window.DentaFlowAuth?.requireSession?.();

    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: rosterFetchHeaders(),
    });

    assertAuthorizedResponse(response);

    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    const trimmedText = rawText.trim();

    let payload;
    try {
      payload = trimmedText ? JSON.parse(trimmedText) : [];
    } catch (parseError) {
      if (!trimmedText && response.ok) {
        payload = [];
      } else {
        throw new Error(`Réponse non-JSON (${contentType || 'unknown'}): ${parseError.message}`);
      }
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 200)}`);
    }

    const pipeline = buildRosterPipeline(payload);
    const rowCount = Array.isArray(pipeline?.rawRows) ? pipeline.rawRows.length : 0;
    console.log('[Roster Sync] Success | Rows: ' + rowCount + ' | Status: ' + response.status + ' OK');

    return { response, contentType, rawText, url, payload, pipeline };
  }

  async function loadPlanning() {
    try {
      await window.DentaFlowAuth?.requireSession?.();
    } catch {
      return;
    }

    showTableLoader();
    setSyncIndicator('loading');

    const primaryUrl = CONFIG.ROSTER_PROXY;
    console.log('[Roster] Fetch started | endpoint: roster proxy');

    try {
      const result = await fetchRosterPayload(primaryUrl);

      const { rawRows, normalized, todayRecords } = result.pipeline;

      console.log('[Roster] Parsed rows:', rawRows.length, '| Normalized:', normalized.length, '| Today:', todayRecords.length);

      allRosterRecords = normalized;
      renderPlanning(todayRecords);
      setSyncIndicator('ok');
      queueOsBootSequence();
    } catch (error) {
      if (isUnauthorizedError(error)) {
        // Logout/redirect already in flight — do not enter Mode dégradé.
        return;
      }
      if (isFetchAborted(error)) {
        console.warn('[Sync] Fetch safely aborted by lifecycle controller. Suppressing UI error injection.');
        if (allRosterRecords.length) {
          renderPlanning(filterTodayRosterRecords(allRosterRecords));
          setSyncIndicator('ok');
        }
        return;
      }
      console.error('[Roster] Fetch failed:', error?.message || error);

      showTableError(formatRosterErrorMessage(error));
      queueOsBootSequence();
    }
  }

  const OS_BOOT_SELECTORS = {
    sidebar: '.assistant-sidebar',
    pulseCards: '#assistant-pulse-grid .pulse-card',
    gridPanels: '#view-overview .assistant-grid .assistant-panel',
    dataRows: '#planning-timeline .timeline-item:not(.timeline-empty):not(.timeline-loading):not(.timeline-error), #waitlist-panel-list tr:not(.waitlist-empty), #crm-table-body tr.crm-table-row',
  };

  function collectOsBootTargets() {
    return [
      assistantQuery(OS_BOOT_SELECTORS.sidebar),
      ...assistantQueryAll(OS_BOOT_SELECTORS.pulseCards),
      ...assistantQueryAll(OS_BOOT_SELECTORS.gridPanels),
      ...assistantQueryAll(OS_BOOT_SELECTORS.dataRows),
    ].filter(Boolean);
  }

  function revealOsBootFallback() {
    document.body.classList.remove('os-boot-pending');
    const targets = collectOsBootTargets();
    if (typeof gsap !== 'undefined' && targets.length) {
      gsap.set(targets, { opacity: 1, x: 0, y: 0, clearProps: 'opacity,transform' });
      return;
    }
    targets.forEach((el) => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
  }

  function queueOsBootSequence() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => runOsBootSequence());
    });
  }

  function runOsBootSequence() {
    if (osBootSequencePlayed) return;
    osBootSequencePlayed = true;

    if (typeof gsap === 'undefined') {
      revealOsBootFallback();
      return;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealOsBootFallback();
      return;
    }

    const sidebar = assistantQuery(OS_BOOT_SELECTORS.sidebar);
    const pulseCards = assistantQueryAll(OS_BOOT_SELECTORS.pulseCards);
    const gridPanels = assistantQueryAll(OS_BOOT_SELECTORS.gridPanels);
    const dataRows = assistantQueryAll(OS_BOOT_SELECTORS.dataRows);
    const bootTargets = collectOsBootTargets();
    const hasBootContent = sidebar || pulseCards.length || gridPanels.length || dataRows.length;

    if (!hasBootContent) {
      revealOsBootFallback();
      return;
    }

    const bootTimeline = gsap.timeline({
      defaults: { ease: 'power4.out', duration: 0.5 },
      onComplete: () => {
        document.body.classList.remove('os-boot-pending');
        if (bootTargets.length) {
          gsap.set(bootTargets, { clearProps: 'opacity,transform' });
        }
      },
    });

    if (sidebar) {
      bootTimeline.fromTo(
        sidebar,
        { x: -30, opacity: 0 },
        { x: 0, opacity: 1, immediateRender: true }
      );
    }

    if (pulseCards.length) {
      bootTimeline.fromTo(
        pulseCards,
        { y: 12, opacity: 0 },
        { y: 0, opacity: 1, stagger: 0.06, immediateRender: false },
        '-=0.3'
      );
    }

    if (gridPanels.length) {
      bootTimeline.fromTo(
        gridPanels,
        { y: 16, opacity: 0 },
        { y: 0, opacity: 1, immediateRender: false },
        '-=0.15'
      );
    }

    if (dataRows.length) {
      bootTimeline.fromTo(
        dataRows,
        { opacity: 0 },
        { opacity: 1, stagger: 0.03, duration: 0.35, ease: 'power4.out', immediateRender: false },
        '-=0.2'
      );
    }
  }

  async function updateRosterStatus(selectEl, previousStatus, extra = {}) {
    const bookingId = selectEl.dataset.bookingId || '';
    const newStatus = selectEl.value;

    selectEl.disabled = true;
    selectEl.classList.add('status-updating');
    selectEl.classList.remove('status-success', 'status-error');

    try {
      const body = { bookingId, newStatus };
      if (extra.cancelReason) body.cancelReason = extra.cancelReason;
      const response = await fetch(CONFIG.UPDATE_STATUS_PROXY, {
        method: 'POST',
        credentials: 'include',
        headers: apiHeaders(),
        body: JSON.stringify(body),
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

      selectEl.classList.remove('status-updating');
      selectEl.classList.add('status-success');

      const container = selectEl.closest('[data-patient-id]');
      const patientId = container?.dataset.patientId;
      const patient = rosterData.find(p => String(p.id) === String(patientId));
      if (patient) {
        patient.status = newStatus;
        updateRosterStats(rosterData);
      }

      if (patientId) {
        document.querySelectorAll(`[data-patient-id="${patientId}"] .status-select`).forEach(otherSelect => {
          if (otherSelect !== selectEl) {
            otherSelect.value = newStatus;
            applyMatteSelectSkin(otherSelect, newStatus);
          }
        });
        applyMatteSelectSkin(selectEl, newStatus);
        renderOperationalPulse(computeOperationalPulse(rosterData));
        renderLateList(rosterData);
        renderStatusBoard(rosterData);
        refreshHandoffBookingOptions(rosterData);
        if (dashboardCalendar) dashboardCalendar.refetchEvents();
        const row = document.querySelector(`#planning-timeline .timeline-item[data-patient-id="${patientId}"]`)
          || document.querySelector(`tr[data-patient-id="${patientId}"]`);
        const card = document.querySelector(`.roster-card[data-patient-id="${patientId}"]`);
        if (row) row.classList.toggle('is-cancelled', newStatus === 'No-show');
        if (card) card.classList.toggle('is-cancelled', newStatus === 'No-show');
      }

      setTimeout(() => {
        selectEl.classList.remove('status-success');
        selectEl.disabled = false;
      }, 2000);
    } catch (error) {
      if (isFetchAborted(error)) {
        console.warn('[Sync] Fetch safely aborted by lifecycle controller. Suppressing UI error injection.');
        return;
      }
      console.error('[Roster Status] Update failed:', error?.message || error);
      selectEl.value = previousStatus;
      applyMatteSelectSkin(selectEl, previousStatus);
      selectEl.classList.remove('status-updating');
      selectEl.classList.add('status-error');
      selectEl.setAttribute('aria-invalid', 'true');
      selectEl.disabled = false;
      const msg = String(error?.message || '');
      if (msg.includes('Session expirée')) {
        alert('Session expirée. Veuillez vous reconnecter.');
      } else {
        alert('Échec de la mise à jour du statut. Réessayez.');
      }
      setTimeout(() => {
        selectEl.classList.remove('status-error');
        selectEl.removeAttribute('aria-invalid');
      }, 2000);
    }
  }

  function initStatusListener() {
    const timeline = $('planning-timeline');
    const table = document.querySelector('.roster-table');
    const cards = $('roster-cards');
    const board = $('status-board');

    function rememberPreviousStatus(event) {
      const select = event.target.closest('.status-select');
      if (select) select.dataset.previousStatus = select.value;
    }

    function handleChange(event) {
      const select = event.target.closest('.status-select');
      if (!select || select.disabled) return;

      const previousStatus = select.dataset.previousStatus ?? select.value;
      const newStatus = select.value;
      if (newStatus === 'Annulé' && previousStatus !== 'Annulé') {
        const container = select.closest('[data-patient-id]');
        const patientId = container?.dataset.patientId;
        const patient = rosterData.find((p) => String(p.id) === String(patientId));
        const name = patient?.name || 'ce patient';
        void askConfirm(`Annuler le rendez-vous de ${name} ?`).then(async (ok) => {
          if (!ok) {
            select.value = previousStatus;
            applyMatteSelectSkin(select, previousStatus);
            return;
          }
          const reason = await pickCancelReason();
          if (!reason) {
            select.value = previousStatus;
            applyMatteSelectSkin(select, previousStatus);
            return;
          }
          updateRosterStatus(select, previousStatus, { cancelReason: reason });
        });
        return;
      }
      updateRosterStatus(select, previousStatus);
    }

    timeline?.addEventListener('focusin', rememberPreviousStatus);
    table?.addEventListener('focusin', rememberPreviousStatus);
    cards?.addEventListener('focusin', rememberPreviousStatus);
    board?.addEventListener('focusin', rememberPreviousStatus);
    timeline?.addEventListener('change', handleChange);
    table?.addEventListener('change', handleChange);
    cards?.addEventListener('change', handleChange);
    board?.addEventListener('change', handleChange);
  }

  function clearMobileOverviewSectionClasses() {
    MOBILE_OVERVIEW_SECTIONS.forEach((key) => {
      document.body.classList.remove(`mobile-section-${key}`);
    });
  }

  function applyMobileOverviewSection(sectionKey) {
    MOBILE_OVERVIEW_SECTIONS.forEach((key) => {
      document.body.classList.toggle(`mobile-section-${key}`, sectionKey === key);
    });
  }

  function isMobileViewport() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function syncDockNavStates(tabKey) {
    document.querySelectorAll('.mobile-bottom-nav .tab-link[data-nav]').forEach((link) => {
      const isActive = link.dataset.nav === tabKey;
      link.classList.toggle('is-active', isActive);
      if (isActive) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    assistantQueryAll('.nav-link[data-nav]').forEach((link) => {
      const navKey = link.dataset.nav;
      const isActive = MOBILE_OVERVIEW_SECTIONS.has(tabKey)
        ? navKey === 'overview'
        : MOBILE_FULL_VIEW_TABS.has(tabKey) && navKey === tabKey;
      link.classList.toggle('is-active', isActive);
      if (isActive) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  function navigateToMobileTab(tabKey) {
    if (!MOBILE_DOCK_NAV.has(tabKey)) return;
    if (
      tabKey === activeMobileTab
      && MOBILE_OVERVIEW_SECTIONS.has(tabKey)
      && activeView === 'overview'
    ) {
      return;
    }
    if (tabKey === activeMobileTab && tabKey === 'waitlist' && activeView === 'waitlist') {
      return;
    }
    if (tabKey === activeMobileTab && tabKey === 'settings' && activeView === 'settings') {
      return;
    }

    activeMobileTab = tabKey;

    if (MOBILE_OVERVIEW_SECTIONS.has(tabKey)) {
      if (activeView !== 'overview') {
        navigateToView('overview', { skipMobileSync: true });
      }
      applyMobileOverviewSection(tabKey);
    } else if (MOBILE_FULL_VIEW_TABS.has(tabKey)) {
      clearMobileOverviewSectionClasses();
      if (activeView !== tabKey) {
        navigateToView(tabKey, { skipMobileSync: true });
      }
    }

    syncDockNavStates(tabKey);
  }

  function initMobileDock() {
    const mq = window.matchMedia('(max-width: 768px)');
    const applyMobileDockState = () => {
      const mobile = mq.matches;
      document.body.classList.toggle('mobile-dock-active', mobile);

      if (!mobile) {
        clearMobileOverviewSectionClasses();
        return;
      }

      if (MOBILE_OVERVIEW_SECTIONS.has(activeMobileTab) && activeView === 'overview') {
        applyMobileOverviewSection(activeMobileTab);
      } else if (activeMobileTab === 'waitlist' && activeView === 'waitlist') {
        clearMobileOverviewSectionClasses();
      } else if (activeMobileTab === 'settings' && activeView === 'settings') {
        clearMobileOverviewSectionClasses();
      } else if (activeView === 'overview') {
        activeMobileTab = 'overview';
        applyMobileOverviewSection('overview');
      } else if (activeView === 'waitlist') {
        activeMobileTab = 'waitlist';
        clearMobileOverviewSectionClasses();
      } else if (activeView === 'settings') {
        activeMobileTab = 'settings';
        clearMobileOverviewSectionClasses();
      }

      syncDockNavStates(activeMobileTab);
    };

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', applyMobileDockState);
    } else {
      mq.addListener(applyMobileDockState);
    }

    applyMobileDockState();
  }

  function initNavigation() {
    assistantQueryAll('.nav-link[data-nav]').forEach((link) => {
      link?.addEventListener('click', (event) => {
        event.preventDefault();
        const nav = link.dataset.nav;
        if (nav && VIEW_MAP[nav]) navigateToView(nav);
      });
    });

    document.querySelectorAll('.mobile-bottom-nav .tab-link[data-nav]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const nav = link.dataset.nav;
        if (nav && MOBILE_DOCK_NAV.has(nav)) {
          navigateToMobileTab(nav);
        }
      });
    });

    initMobileDock();
  }

  function initMobileNav() {
    const root = document.getElementById('assistant-mount')
      || document.getElementById('assistant-shell')
      || document.querySelector('.assistant-app-root')
      || document;
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

  const VIEW_TRANSITION_MS = 400;
  const SETTINGS_STORAGE_KEY = 'dentaflow_assistant_prefs';

  const DEFAULT_SETTINGS = {
    theme: 'pearl-clinic',
    profileName: '',
    profileSpecialty: 'Assistante dentaire',
    smsReminders: true,
    emailReminders: true,
  };

  let volatileSettings = { ...DEFAULT_SETTINGS };

  function normalizeTheme(theme) {
    return theme === 'pearl-clinic' || theme === 'light' ? 'pearl-clinic' : 'oak-lounge';
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        volatileSettings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          theme: normalizeTheme(
            parsed.theme
            || window.DentaFlowTheme?.readStoredTheme?.()
            || DEFAULT_SETTINGS.theme
          ),
          profileName: parsed.profileName ?? DEFAULT_SETTINGS.profileName,
          profileSpecialty: parsed.profileSpecialty ?? DEFAULT_SETTINGS.profileSpecialty,
          smsReminders: parsed.smsReminders !== false,
          emailReminders: parsed.emailReminders !== false,
        };
      } else {
        const storedTheme = window.DentaFlowTheme?.readStoredTheme?.();
        volatileSettings = {
          ...DEFAULT_SETTINGS,
          theme: storedTheme ? normalizeTheme(storedTheme) : DEFAULT_SETTINGS.theme,
        };
      }
    } catch (error) {
      console.warn('[Settings] localStorage read failed:', error);
      volatileSettings = { ...DEFAULT_SETTINGS };
    }
    return { ...volatileSettings };
  }

  function saveSettings(partial) {
    volatileSettings = { ...volatileSettings, ...partial };
    if (partial.theme != null) {
      volatileSettings.theme = normalizeTheme(partial.theme);
      window.DentaFlowTheme?.writeStoredTheme?.(volatileSettings.theme);
    }
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(volatileSettings));
    } catch (error) {
      console.warn('[Settings] localStorage save failed:', error);
    }
  }

  function restartViewStaggerAnimations(viewEl) {
    if (!viewEl) return;
    viewEl.classList.remove('view-stagger');
    void viewEl.offsetWidth;
    viewEl.classList.add('view-stagger');
  }

  function activateDashboardView(viewEl, { animate = true } = {}) {
    if (!viewEl) return;

    assistantQueryAll('.dashboard-view').forEach(view => {
      view.classList.remove('active', 'view-enter', 'view-enter-ready', 'view-stagger');
      view.setAttribute('aria-hidden', 'true');
    });

    viewEl.classList.add('active');
    viewEl.setAttribute('aria-hidden', 'false');

    if (animate) {
      viewEl.classList.add('view-enter');
      restartViewStaggerAnimations(viewEl);
      window.setTimeout(() => {
        viewEl.classList.remove('view-enter');
        viewEl.classList.add('view-enter-ready');
      }, VIEW_TRANSITION_MS);
    } else {
      viewEl.classList.add('view-enter-ready', 'view-stagger');
    }
  }
  function navigateToView(viewKey, options = {}) {
    const { skipMobileSync = false, animate = true } = options;
    const targetId = VIEW_MAP[viewKey];
    if (!targetId) return;
    if (viewKey === activeView && !skipMobileSync) return;

    const targetView = document.getElementById(targetId);
    if (!targetView) return;

    activateDashboardView(targetView, { animate });

    if (isMobileViewport() && !skipMobileSync) {
      if (viewKey === 'overview') {
        activeMobileTab = MOBILE_OVERVIEW_SECTIONS.has(activeMobileTab) ? activeMobileTab : 'overview';
        applyMobileOverviewSection(activeMobileTab);
      } else if (viewKey === 'waitlist' || viewKey === 'settings') {
        activeMobileTab = viewKey;
        clearMobileOverviewSectionClasses();
      } else {
        clearMobileOverviewSectionClasses();
      }
      syncDockNavStates(activeMobileTab);
    } else {
      assistantQueryAll('.nav-link[data-nav]').forEach((link) => {
        const isActive = link.dataset.nav === viewKey;
        link.classList.toggle('is-active', isActive);
        if (isActive) {
          link.setAttribute('aria-current', 'page');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }

    activeView = viewKey;

    const focusTarget = targetView.querySelector('.view-page-title, .assistant-header__title');
    if (focusTarget) {
      focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus({ preventScroll: true });
      focusTarget.removeAttribute('tabindex');
    }

    if (viewKey === 'calendar') {
      requestAnimationFrame(() => initDashboardCalendar());
    }
  }

  const SUBMIT_LOCK_MS = 5000;

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

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text ?? '';
  }

  let dashboardCalendar = null;
  let assistantCalendarChromeBound = false;

  function casablancaIsoDate(value) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' });
  }

  function casablancaDateTimeLocal(value) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Casablanca',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(parsed).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
    );
    if (!parts.year || parts.hour == null) return '';
    const pad = (part) => String(part || '').padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  }

  function familyNameFromPatient(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'Patient';
    return parts[parts.length - 1];
  }

  function mapRosterRowToOpsEvent(row) {
    const startRaw = row.starts_at || row.startTime;
    const start = startRaw ? new Date(startRaw) : null;
    if (!start || Number.isNaN(start.getTime())) return null;
    const duration = Number(row.duration_min) > 0 ? Number(row.duration_min) : 30;
    const end = new Date(start.getTime() + duration * 60_000);
    const patientName = row.patient_name || row.name || 'Patient';
    const treatment = row.treatment_name || row.treatment || 'Consultation';
    const startLocal = casablancaDateTimeLocal(start);
    const endLocal = casablancaDateTimeLocal(end);
    if (!startLocal || !endLocal) return null;
    const cancelled = isPulseCancelledStatus(row.status);
    const kind = bookingKindOf(row);
    const classNames = ['cal-chip'];
    if (kind === 'block') classNames.push('cal-chip--block');
    if (kind === 'emergency_hold') classNames.push('cal-chip--hold');
    if (cancelled) classNames.push('is-cancelled');
    return {
      id: String(row.id || ''),
      title: kind === 'visit' ? familyNameFromPatient(patientName) : (treatment || patientName),
      start: startLocal,
      end: endLocal,
      classNames,
      extendedProps: {
        bookingId: String(row.id || ''),
        patientName,
        treatment,
        phone: row.patient_phone || row.phone || '',
        status: row.status || '',
        durationMin: duration,
        startsAt: startRaw,
        bookingKind: kind,
      },
    };
  }

  async function fetchAssistantRosterRange(fromIso, toIso) {
    const params = new URLSearchParams({ from: fromIso, to: toIso });
    const response = await fetch(`${CONFIG.ROSTER_PROXY}?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      headers: rosterFetchHeaders(),
      cache: 'no-store',
    });
    assertAuthorizedResponse(response);
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  function setAssistantCalendarEmpty(empty) {
    const el = $('asst-calendar-empty');
    if (el) el.hidden = !empty;
  }

  function updateAssistantCalendarTitle() {
    const titleEl = $('asst-calendar-title');
    if (!titleEl || !dashboardCalendar) return;
    titleEl.textContent = String(dashboardCalendar.view?.title || '').trim() || 'Planning';
  }

  function setAssistantCalendarViewButtons(viewType) {
    assistantRoot()?.querySelectorAll('[data-asst-cal-view]').forEach((btn) => {
      const active = btn.getAttribute('data-asst-cal-view') === viewType;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function closeOpsChipSheet() {
    const sheet = $('ops-chip-sheet');
    if (sheet) sheet.hidden = true;
  }

  async function applyOpsStatus(bookingId, newStatus) {
    const body = { bookingId, newStatus };
    if (newStatus === 'Annulé' || newStatus === 'Annule') {
      const reason = await pickCancelReason();
      if (!reason) return;
      body.cancelReason = reason;
    }
    const response = await fetch(CONFIG.UPDATE_STATUS_PROXY, {
      method: 'POST',
      credentials: 'include',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    assertAuthorizedResponse(response);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  function openOpsChipSheet(event, jsEvent) {
    const sheet = $('ops-chip-sheet');
    const who = $('ops-chip-who');
    const meta = $('ops-chip-meta');
    const actions = $('ops-chip-actions');
    if (!sheet || !who || !meta || !actions) return;

    const props = event.extendedProps || {};
    who.textContent = props.patientName || event.title || 'Patient';
    meta.textContent = [event.start ? formatRosterClock({ starts_at: event.start }) : '', props.status, props.treatment]
      .filter(Boolean)
      .join(' · ');
    actions.replaceChildren();

    if (props.bookingKind === 'emergency_hold') {
      const release = document.createElement('button');
      release.type = 'button';
      release.textContent = 'Relâcher';
      release.addEventListener('click', async () => {
        await releaseEmergencyHold(props.bookingId || event.id);
        closeOpsChipSheet();
      });
      actions.appendChild(release);
      sheet.hidden = false;
      const hx = Math.min(window.innerWidth - 240, Math.max(12, jsEvent?.clientX || 24));
      const hy = Math.min(window.innerHeight - 180, Math.max(12, jsEvent?.clientY || 24));
      sheet.style.left = `${hx}px`;
      sheet.style.top = `${hy}px`;
      return;
    }

    if (props.bookingKind === 'block') {
      const note = document.createElement('p');
      note.className = 'ops-chip-sheet__meta';
      note.textContent = 'Blocage docteur. Lecture seule ici.';
      actions.appendChild(note);
      sheet.hidden = false;
      return;
    }

    STATUS_OPTIONS.forEach((status) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = status;
      if (status === props.status || normalizePulseStatus(status) === normalizePulseStatus(props.status)) {
        btn.disabled = true;
      }
      btn.addEventListener('click', async () => {
        try {
          await applyOpsStatus(props.bookingId || event.id, status);
          showToast('Statut mis à jour.', 'success');
          closeOpsChipSheet();
          dashboardCalendar?.refetchEvents();
          loadPlanning();
        } catch {
          showToast('Impossible de changer le statut.', 'error');
        }
      });
      actions.appendChild(btn);
    });

    if (isPulseCancelledStatus(props.status)) {
      const fill = document.createElement('button');
      fill.type = 'button';
      fill.textContent = 'Proposer un patient';
      fill.addEventListener('click', async () => {
        const confirmed = await askConfirm('Remplacer ce créneau avec un patient de la liste d\'attente ?');
        if (!confirmed) return;
        try {
          const start = event.start ? new Date(event.start) : null;
          const slotDate = start ? casablancaIsoDate(start) : '';
          const slotTime = start
            ? start.toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
              timeZone: 'Africa/Casablanca',
            })
            : '';
          const response = await fetch(CONFIG.FILL_GAP_PROXY, {
            method: 'POST',
            credentials: 'include',
            headers: apiHeaders(),
            body: JSON.stringify({ slotDate, slotTime }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload?.ok === false) {
            throw new Error(payload?.error || `HTTP ${response.status}`);
          }
          toastFillGapResult(payload);
          closeOpsChipSheet();
          dashboardCalendar?.refetchEvents();
          loadPlanning();
        } catch {
          showToast('Impossible de combler le créneau.', 'error');
        }
      });
      actions.appendChild(fill);
    }

    sheet.hidden = false;
    const x = Math.min(window.innerWidth - 240, Math.max(12, jsEvent?.clientX || 24));
    const y = Math.min(window.innerHeight - 180, Math.max(12, jsEvent?.clientY || 24));
    sheet.style.left = `${x}px`;
    sheet.style.top = `${y}px`;
  }

  function bindAssistantCalendarChrome() {
    if (assistantCalendarChromeBound) return;
    assistantCalendarChromeBound = true;
    assistantRoot()?.querySelectorAll('[data-asst-cal-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!dashboardCalendar) return;
        const action = btn.getAttribute('data-asst-cal-nav');
        if (action === 'prev') dashboardCalendar.prev();
        if (action === 'next') dashboardCalendar.next();
        if (action === 'today') dashboardCalendar.today();
      });
    });
    assistantRoot()?.querySelectorAll('[data-asst-cal-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!dashboardCalendar) return;
        const view = btn.getAttribute('data-asst-cal-view');
        if (!view) return;
        dashboardCalendar.changeView(view);
        setAssistantCalendarViewButtons(view);
      });
    });
    document.addEventListener('click', (event) => {
      const sheet = $('ops-chip-sheet');
      if (!sheet || sheet.hidden) return;
      if (sheet.contains(event.target) || event.target.closest('.fc-event')) return;
      closeOpsChipSheet();
    });
  }

  function initDashboardCalendar() {
    const el = $('dashboard-cal-inline');
    if (!el) return;

    bindAssistantCalendarChrome();

    if (dashboardCalendar) {
      requestAnimationFrame(() => {
        dashboardCalendar.updateSize();
        updateAssistantCalendarTitle();
      });
      return;
    }

    if (typeof FullCalendar === 'undefined') {
      console.error('[Calendar] FullCalendar library not loaded');
      return;
    }

    el.innerHTML = '';

    dashboardCalendar = new FullCalendar.Calendar(el, {
      initialView: 'timeGridWeek',
      headerToolbar: false,
      locale: 'fr',
      firstDay: 1,
      height: 'auto',
      expandRows: true,
      slotMinTime: '08:00:00',
      slotMaxTime: '19:00:00',
      scrollTime: '08:00:00',
      nowIndicator: true,
      allDaySlot: false,
      slotDuration: '00:30:00',
      slotLabelInterval: '01:00:00',
      slotEventOverlap: false,
      displayEventTime: true,
      displayEventEnd: false,
      eventTimeFormat: {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      },
      eventContent(arg) {
        const wrap = document.createElement('div');
        wrap.className = 'cal-chip__inner';
        if (arg.timeText) {
          const time = document.createElement('span');
          time.className = 'cal-chip__time';
          time.textContent = arg.timeText;
          wrap.appendChild(time);
        }
        const title = document.createElement('span');
        title.className = 'cal-chip__title';
        title.textContent = arg.event.title || '';
        wrap.appendChild(title);
        return { domNodes: [wrap] };
      },
      datesSet(info) {
        updateAssistantCalendarTitle();
        setAssistantCalendarViewButtons(info.view.type);
        closeOpsChipSheet();
      },
      events(info, successCallback, failureCallback) {
        const fromIso = casablancaIsoDate(info.start);
        const exclusiveEnd = new Date(info.end.getTime() - 1);
        const toIso = casablancaIsoDate(exclusiveEnd);
        if (!fromIso || !toIso) {
          successCallback([]);
          setAssistantCalendarEmpty(true);
          return;
        }
        fetchAssistantRosterRange(fromIso, toIso)
          .then((rows) => {
            const events = rows.map(mapRosterRowToOpsEvent).filter(Boolean);
            setAssistantCalendarEmpty(events.length === 0);
            successCallback(events);
          })
          .catch((err) => {
            if (isUnauthorizedError(err)) return;
            console.error('[Calendar] roster load failed:', err?.message || err);
            setAssistantCalendarEmpty(true);
            failureCallback(err);
          });
      },
      eventClick(info) {
        info.jsEvent?.preventDefault();
        info.jsEvent?.stopPropagation();
        openOpsChipSheet(info.event, info.jsEvent);
      },
    });

    dashboardCalendar.render();
    updateAssistantCalendarTitle();
    setAssistantCalendarViewButtons('timeGridWeek');
    window.refreshLucideIcons?.($('view-calendar') || document);
  }

  function waitlistPriorityRank(priority) {
    const key = String(priority || '').trim().toLowerCase();
    if (key.startsWith('urgent') || key === 'urgence') return 0;
    if (key.startsWith('haut')) return 1;
    if (key.startsWith('moy') || key === 'normale') return 2;
    return 3;
  }

  function sortWaitlistByPriority(rows) {
    return [...rows].sort((a, b) => {
      const rank = waitlistPriorityRank(a.priorite || a.priority) - waitlistPriorityRank(b.priorite || b.priority);
      if (rank !== 0) return rank;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
  }

  async function fetchWaitlistEntries() {
    const response = await fetch(CONFIG.ENDPOINTS.WAITLIST_GET, {
      method: 'GET',
      credentials: 'include',
      headers: rosterFetchHeaders(),
      cache: 'no-store',
    });
    assertAuthorizedResponse(response);
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  async function loadWaitlistPanel() {
    try {
      waitlistEntries = await fetchWaitlistEntries();
    } catch (error) {
      if (isUnauthorizedError(error) || isFetchAborted(error)) return;
      console.error('[Waitlist] GET failed:', error?.message || error);
      waitlistEntries = [];
    }
    renderWaitlistPanel();
  }

  function createApptCardElement(appt) {
    return createWaitlistTableRow(appt);
  }

  function renderWaitlistPanel() {
    return safeRender('renderWaitlistPanel', () => {
    const container = $('waitlist-panel-list');
    if (!container) return;
    const sorted = sortWaitlistByPriority(waitlistEntries);
    const waitlist = waitlistUrgentOnly
      ? sorted.filter(isWaitlistUrgent)
      : sorted;
    container.replaceChildren();

    const table = container.closest('.waitlist-table');
    if (!waitlist.length) {
      mountEmptyState('waitlist-empty-state', {
        title: 'Liste d\'attente vide',
        message: 'Ajoutez un nom ci-dessus pour un créneau libéré.',
      });
      if (table) table.hidden = true;
      hideSkeleton('waitlist');
      return;
    }

    clearEmptyState('waitlist-empty-state');
    if (table) table.hidden = false;

    const fragment = document.createDocumentFragment();
    waitlist.forEach((appt) => fragment.appendChild(createWaitlistTableRow({
      ...appt,
      name: appt.name || appt.nom || appt.patient_name,
      phone: appt.phone || appt.telephone || appt.patient_phone,
      priorite: appt.priorite || appt.priority,
    })));
    container.appendChild(fragment);
    refreshInvisibleUIDecorations(container);
    hideSkeleton('waitlist');
    });
  }

  function setWaitlistFormProcessing(form, isProcessing) {
    form.querySelectorAll('.waitlist-input, .waitlist-select, .ghost-select__trigger').forEach((field) => {
      field.style.opacity = isProcessing ? '0.7' : '1';
    });
    form.classList.toggle('is-processing', isProcessing);
  }

  function initWaitlistForm() {
    const form = $('waitlist-form');
    if (!form) return;

    const V = window.DentaFlowValidators;
    V?.bindField($('waitlist-name'), 'name', { required: true });
    V?.bindField($('waitlist-phone'), 'phone', { required: true });

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();

      const btn = $('waitlist-submit-btn');
      const nameEl = $('waitlist-name');
      const phoneEl = $('waitlist-phone');
      const priorityEl = getWaitlistPriorityInput();
      const consentEl = $('waitlist-sms-consent');

      if (!btn || !nameEl || !phoneEl || !priorityEl) return;

      const patientName = nameEl.value.trim();
      const patientPhone = phoneEl.value.trim();
      const patientPriority = priorityEl.value;

      const nameOk = V ? V.validateInput(nameEl, 'name', { required: true }) : Boolean(patientName);
      const phoneOk = V ? V.validateInput(phoneEl, 'phone', { required: true }) : Boolean(patientPhone);

      if (!nameOk || !phoneOk) {
        showToast('Veuillez renseigner le nom et le numéro de téléphone.', 'warning');
        if (!nameOk) nameEl.focus();
        else phoneEl.focus();
        return;
      }

      if (!consentEl?.checked) {
        showToast('Consentement SMS requis (Loi 09-08).', 'warning');
        consentEl?.focus();
        return;
      }

      const defaultBtnHtml = btn.innerHTML;
      const loadingBtnHtml = '<span class="waitlist-btn-spinner" aria-hidden="true"></span> Enregistrement...';

      btn.disabled = true;
      btn.innerHTML = loadingBtnHtml;
      setWaitlistFormProcessing(form, true);

      try {
        const consentSms = Boolean(consentEl?.checked);
        const consentTimestamp = consentSms ? new Date().toISOString() : null;

        const response = await fetch(
          CONFIG.ENDPOINTS.WAITLIST_ADD,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: patientName,
              phone: patientPhone,
              priority: patientPriority,
              consent_sms: consentSms,
              consent_timestamp: consentTimestamp,
            }),
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText.slice(0, 160)}`);
        }

        form.reset();
        if (setWaitlistPriorityValue) setWaitlistPriorityValue('Normale');
        else priorityEl.value = 'Normale';
        await loadWaitlistPanel();
        showToast('Patient ajouté à la liste d\'attente avec succès', 'success');
      } catch (error) {
        if (isFetchAborted(error)) {
          console.warn('[Sync] Fetch safely aborted by lifecycle controller. Suppressing UI error injection.');
          return;
        }
        console.error('[Waitlist] Submission failed:', error?.message || error);
        showToast('Échec de la connexion au serveur. Veuillez réessayer.', 'error');
      } finally {
        btn.innerHTML = defaultBtnHtml;
        btn.disabled = false;
        setWaitlistFormProcessing(form, false);
      }
    });
  }

  function prependWaitlistEntry({ nom, telephone, priorite }) {
    const container = $('waitlist-panel-list');
    if (!container) return;

    clearEmptyState('waitlist-empty-state');
    const table = container.closest('.waitlist-table');
    if (table) table.hidden = false;

    const tagClass = priorite === 'Haute' || priorite === 'Urgence' ? 'urgence' : 'consultation';
    const row = createWaitlistTableRow({
      name: nom,
      phone: telephone || 'Non renseigné',
      treatment: priorite,
      tagClass,
      priorite,
    });
    container.prepend(row);
  }

  function applyTheme(theme) {
    const resolved = window.DentaFlowTheme?.applyTheme
      ? window.DentaFlowTheme.applyTheme(theme)
      : normalizeTheme(theme);
    if (!window.DentaFlowTheme?.applyTheme) {
      document.documentElement.setAttribute('data-theme', resolved);
    }
    volatileSettings.theme = resolved;
    updateThemeSwitcherUI(resolved);
    saveSettings({ theme: resolved });
  }

  function updateThemeSwitcherUI(theme) {
    const oakBtn = $('theme-btn-oak');
    const pearlBtn = $('theme-btn-pearl');
    const isPearl = theme === 'pearl-clinic';

    oakBtn?.classList.toggle('is-active', !isPearl);
    pearlBtn?.classList.toggle('is-active', isPearl);
    oakBtn?.setAttribute('aria-pressed', !isPearl ? 'true' : 'false');
    pearlBtn?.setAttribute('aria-pressed', isPearl ? 'true' : 'false');
  }

  function initThemeSwitcher() {
    const oakBtn = $('theme-btn-oak');
    const pearlBtn = $('theme-btn-pearl');
    if (!oakBtn || !pearlBtn) return;

    updateThemeSwitcherUI(volatileSettings.theme);
    oakBtn?.addEventListener('click', () => applyTheme('oak-lounge'));
    pearlBtn?.addEventListener('click', () => applyTheme('pearl-clinic'));
  }

  function applyUserProfile(name, specialty) {
    const displayName = (name ?? '').trim()
      || window.DentaFlowTheme?.getSessionDisplayName?.()
      || DEFAULT_SETTINGS.profileName
      || 'Assistante';
    const displayRole = (specialty ?? '').trim() || DEFAULT_SETTINGS.profileSpecialty;
    const initials = extractInitials(displayName);
    const firstName = displayName.split(/\s+/)[0] || displayName;

    const avatarEl = $('profile-avatar');
    const nameEl = $('profile-name');
    const roleEl = $('profile-role');
    const heroEl = $('hero-profile-name');

    if (avatarEl) avatarEl.textContent = initials;
    if (nameEl) nameEl.textContent = displayName;
    if (roleEl) roleEl.textContent = displayRole;
    if (heroEl) heroEl.textContent = firstName;
  }

  function initUserProfile() {
    const nameEl = $('settings-profile-name');
    const specialtyEl = $('settings-profile-specialty');
    const profileName = window.DentaFlowTheme?.getSessionDisplayName?.()
      || DEFAULT_SETTINGS.profileName
      || 'Assistante';
    const profileSpecialty = window.DentaFlowTheme?.getSessionRoleLabel?.()
      || DEFAULT_SETTINGS.profileSpecialty;

    if (nameEl) {
      nameEl.value = profileName;
      nameEl.readOnly = true;
    }
    if (specialtyEl) {
      specialtyEl.value = profileSpecialty;
      specialtyEl.readOnly = true;
    }

    applyUserProfile(profileName, profileSpecialty);
  }

  function initSettings() {
    const saved = loadSettings();
    const smsToggle = $('settings-sms-toggle');
    const emailToggle = $('settings-email-toggle');

    if (smsToggle && smsToggle.dataset.prefsBound !== 'true') {
      smsToggle.checked = saved.smsReminders !== false;
    }
    if (emailToggle && emailToggle.dataset.prefsBound !== 'true') {
      emailToggle.checked = saved.emailReminders !== false;
    }
  }

  function getCrmStatutTagClass(statut) {
    const normalised = (statut ?? '').toLowerCase();
    if (normalised.includes('confirm')) return 'crm-tag--confirmé';
    if (normalised.includes('salle') && normalised.includes('attente')) return 'crm-tag--attente';
    if (normalised.includes('soin')) return 'crm-tag--gold';
    if (normalised.includes('termin')) return 'crm-tag--confirmé';
    if (normalised.includes('no-show') || normalised.includes('annul')) return 'crm-tag--urgence';
    if (normalised.includes('attente')) return 'crm-tag--attente';
    return '';
  }

  function formatCrmLastVisit(rawDate) {
    if (rawDate == null || rawDate === '') return 'Non renseigné';
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) return 'Non renseigné';
    return parsed.toLocaleString('fr-MA', {
      timeZone: 'Africa/Casablanca',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  function toCrmPatient(record) {
    if (!record) return null;
    const coverage = record.coverage ?? record.insurance ?? '';
    const billingStatus = String(record.billingStatus || '').trim();
    return {
      id: record.id,
      name: record.name || 'Non spécifié',
      phone: record.phone || '',
      email: record.email || '',
      motif: record.treatment || 'Consultation',
      status: record.status || 'Confirmé',
      observations: record.observations || '',
      coverage,
      insurance: coverage,
      billingStatus,
      lastVisit: formatCrmLastVisit(record.rawDate),
    };
  }

  function buildStatusPill(label, modifierClass = '') {
    const safeLabel = escapeHtml(label || 'Non renseigné');
    const classes = ['status-pill', modifierClass].filter(Boolean).join(' ');
    return `<span class="${classes}"><span class="status-pill__dot" aria-hidden="true"></span>${safeLabel}</span>`;
  }

  function buildCrmStatusBadge(status) {
    return buildStatusPill(status || 'Confirmé', getCrmStatutTagClass(status));
  }

  function buildMotifPill(motif) {
    return buildStatusPill(motif || 'Consultation', 'status-pill--neutral');
  }

  function updateCRMSidePanel(patientData) {
    if (!patientData) return;

    setText('crm-panel-name', patientData.name || 'Non spécifié');
    setCopyableField('crm-panel-phone', patientData.phone, 'Non renseigné');
    setCopyableField('crm-panel-insurance', patientData.insurance, 'Non renseigné');
    setText('crm-panel-last-visit', patientData.lastVisit || 'Non renseigné');
    setText('crm-panel-email', patientData.email || 'Non renseigné');
    setText('crm-panel-motif', patientData.motif || 'Consultation');
    setText(
      'crm-panel-observations',
      patientData.observations || 'Aucune observation clinique enregistrée.'
    );

    const subtitleEl = $('crm-panel-subtitle');
    if (subtitleEl) {
      const subtitleParts = [patientData.phone, patientData.email].filter(Boolean);
      subtitleEl.textContent = subtitleParts.length
        ? subtitleParts.join(' · ')
        : 'Coordonnées non renseignées';
    }

    const statusEl = $('crm-panel-status');
    if (statusEl) {
      const statusLabel = patientData.status || 'Confirmé';
      const mod = getCrmStatutTagClass(statusLabel);
      statusEl.className = `crm-side-panel-statut status-pill ${mod}`.trim();
      fillStatusPillElement(statusEl, statusLabel, mod);
    }
  }

  function renderCRMTable(appointmentsArray) {
    return safeRender('renderCRMTable', () => {
    const tbody = document.getElementById('crm-table-body');
    if (!tbody) return;

    const rows = Array.isArray(appointmentsArray) ? appointmentsArray.filter(Boolean) : [];
    crmPatientsById = {};
    tbody.replaceChildren();

    if (!rows.length) {
      const emptyHost = $('crm-empty-state');
      const scroll = tbody.closest('.crm-table-scroll');
      if (emptyHost) {
        emptyHost.hidden = false;
        const title = emptyHost.querySelector('.ios-empty__title');
        const text = emptyHost.querySelector('.ios-empty__text');
        if (title) title.textContent = 'Aucun dossier à afficher';
        if (text) {
          text.textContent = $('crm-filter-unpaid')?.getAttribute('aria-pressed') === 'true'
            ? 'Aucun dossier non payé pour aujourd\'hui. Désactivez le filtre pour voir tous les patients du jour.'
            : 'Les rendez-vous du jour apparaissent ici. Recherchez un nom ou un téléphone pour ouvrir un historique.';
        }
      }
      if (scroll) scroll.hidden = true;
      return;
    }

    const emptyHost = $('crm-empty-state');
    const scroll = tbody.closest('.crm-table-scroll');
    if (emptyHost) emptyHost.hidden = true;
    if (scroll) scroll.hidden = false;

    rows.forEach((record) => {
      const patient = toCrmPatient(record);
      if (!patient?.id) return;

      crmPatientsById[String(patient.id)] = patient;

      const tr = document.createElement('tr');
      tr.className = 'crm-table-row';
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.dataset.patientId = String(patient.id);

      const nameCell = document.createElement('td');
      const hasNotes = Boolean(String(patient.observations || '').trim());
      if (hasNotes) {
        nameCell.className = 'has-notes';
        nameCell.textContent = patient.name || '';
        const indicator = document.createElement('span');
        indicator.className = 'notes-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        indicator.dataset.tooltip = 'Notes internes disponibles';
        nameCell.appendChild(indicator);
      } else {
        nameCell.textContent = patient.name || '';
      }
      if (patient.name) nameCell.dataset.tooltip = patient.name;

      const phoneCell = document.createElement('td');
      if (patient.phone) {
        phoneCell.appendChild(createCopyableSpan(patient.phone));
      } else {
        phoneCell.textContent = 'Non renseigné';
      }

      const emailCell = document.createElement('td');
      emailCell.textContent = patient.email || 'Non renseigné';

      const motifCell = document.createElement('td');
      motifCell.appendChild(createStatusPillElement(
        patient.motif || 'Consultation',
        'status-pill--neutral'
      ));

      const billingCell = document.createElement('td');
      const billingLabel = patient.billingStatus || 'Non renseigné';
      if (billingLabel && billingLabel !== '—' && billingLabel !== 'Non renseigné') {
        billingCell.appendChild(createStatusPillElement(
          billingLabel,
          getBillingStatusPillClass(billingLabel)
        ));
      } else {
        billingCell.textContent = 'Non renseigné';
      }

      const statusCell = document.createElement('td');
      statusCell.appendChild(createStatusPillElement(
        patient.status || 'Confirmé',
        getCrmStatutTagClass(patient.status)
      ));

      tr.dataset.billingStatus = patient.billingStatus || '';

      tr.append(nameCell, phoneCell, emailCell, motifCell, billingCell, statusCell);
      tbody.appendChild(tr);
    });

    const firstRow = tbody.querySelector('.crm-table-row');
    if (firstRow) firstRow.classList.add('active-row');
    refreshInvisibleUIDecorations(tbody);
    applyCrmRowVisibility();
    });
  }

  function readCrmRowData(row) {
    const patientId = row?.dataset?.patientId;
    if (patientId && crmPatientsById[patientId]) {
      return crmPatientsById[patientId];
    }

    const { dataset } = row;
    return {
      name: dataset.name ?? row.cells[0]?.textContent.trim() ?? 'Non spécifié',
      phone: dataset.phone ?? row.cells[1]?.textContent.trim() ?? '',
      email: dataset.email ?? row.cells[2]?.textContent.trim() ?? '',
      motif: dataset.motif ?? row.cells[3]?.textContent.trim() ?? 'Consultation',
      status: dataset.statut ?? row.cells[5]?.textContent.trim() ?? 'Confirmé',
      billingStatus: dataset.billingStatus ?? row.cells[4]?.textContent.trim() ?? '',
      lastVisit: dataset.lastVisit ?? 'Non renseigné',
      observations: dataset.observations ?? '',
      insurance: dataset.insurance ?? dataset.coverage ?? '',
      coverage: dataset.coverage ?? dataset.insurance ?? '',
    };
  }

  function applyCrmRowVisibility() {
    const searchEl = $('crm-search');
    const tbody = $('crm-table-body');
    if (!tbody) return;

    const query = (searchEl?.value || '').trim().toLowerCase();
    tbody.querySelectorAll('tr.crm-table-row').forEach((row) => {
      const text = row.textContent.toLowerCase();
      const matchesSearch = !query || text.includes(query);
      const billingStatus = row.dataset.billingStatus || '';
      const matchesBilling = !crmUnpaidOnly || isUnpaidBillingStatus(billingStatus);
      row.classList.toggle('is-hidden', !(matchesSearch && matchesBilling));
    });
  }

  function activateCrmRow(row) {
    if (!row || row.classList.contains('is-hidden') || row.classList.contains('crm-table-empty')) {
      return;
    }

    document.querySelectorAll('#crm-table-body .crm-table-row.active-row').forEach((otherRow) => {
      otherRow.classList.remove('active-row');
    });
    row.classList.add('active-row');

    const patient = readCrmRowData(row);
    updateCRMSidePanel(patient);
    openCrmSidePanel(patient, row);
  }

  function openCrmSidePanel(patient, selectedRow) {
    const root = $('crm-side-panel');
    if (!root) return;

    updateCRMSidePanel(patient);

    assistantQueryAll('.crm-table-row.active-row').forEach((row) => {
      if (row !== selectedRow) row.classList.remove('active-row');
    });
    selectedRow?.classList.add('active-row');

    root.classList.add('is-active');
    root.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    requestAnimationFrame(() => {
      $('crm-side-panel-close')?.focus();
    });
  }

  function closeCrmSidePanel() {
    const root = $('crm-side-panel');
    if (!root || !root.classList.contains('is-active')) return;

    root.classList.remove('is-active');
    root.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';

    assistantQueryAll('.crm-table-row.active-row').forEach((row) => {
      row.classList.remove('active-row');
    });
  }

  function initCrmBillingFilter() {
    const chip = $('crm-filter-unpaid');
    if (!chip || chip.dataset.bound === 'true') return;
    chip.dataset.bound = 'true';

    chip.addEventListener('click', () => {
      crmUnpaidOnly = !crmUnpaidOnly;
      chip.classList.toggle('is-active', crmUnpaidOnly);
      chip.setAttribute('aria-pressed', String(crmUnpaidOnly));
      applyCrmRowVisibility();
    });
  }

  function initCrmSearch() {
    const searchEl = $('crm-search');
    const tbody = $('crm-table-body');
    if (!searchEl || !tbody) return;

    searchEl?.addEventListener('input', applyCrmRowVisibility);
    initCrmBillingFilter();
  }

  function initWaitlistUrgentToggle() {
    const toggle = $('waitlist-urgent-toggle');
    if (!toggle || toggle.dataset.bound === 'true') return;
    toggle.dataset.bound = 'true';

    toggle.addEventListener('click', () => {
      waitlistUrgentOnly = !waitlistUrgentOnly;
      toggle.classList.toggle('is-active', waitlistUrgentOnly);
      toggle.setAttribute('aria-pressed', String(waitlistUrgentOnly));

      const tbody = $('waitlist-panel-list');
      const table = tbody?.closest('.waitlist-table');
      if (tbody) tbody.classList.add('is-filtering');
      if (table) table.classList.add('is-filtering');

      renderWaitlistPanel();

      requestAnimationFrame(() => {
        tbody?.classList.remove('is-filtering');
        table?.classList.remove('is-filtering');
      });
    });
  }

  function initCrmSidePanel() {
    const root = $('crm-side-panel');
    const overlay = $('crm-side-panel-overlay');
    const closeBtn = $('crm-side-panel-close');
    const tbody = $('crm-table-body');
    if (!root || !tbody) return;

    function handleRowActivate(row) {
      activateCrmRow(row);
    }

    tbody?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('.crm-table-row');
      if (!row) return;
      event.preventDefault();
      handleRowActivate(row);
    });

    closeBtn?.addEventListener('click', closeCrmSidePanel);
    overlay?.addEventListener('click', closeCrmSidePanel);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && root.classList.contains('is-active')) {
        closeCrmSidePanel();
      }
    });
  }

  function toastFillGapResult(payload) {
    const booking = payload?.data?.booking;
    const candidates = Array.isArray(payload?.data?.candidates) ? payload.data.candidates : [];
    if (booking) {
      showToast('Créneau comblé depuis la liste d\'attente.', 'success');
      return;
    }
    if (candidates.length) {
      const label = candidates.length === 1
        ? '1 patient prioritaire disponible sur la liste d\'attente.'
        : `${candidates.length} patients prioritaires disponibles sur la liste d'attente.`;
      showToast(label, 'success');
      return;
    }
    showToast('Aucun patient prioritaire sur la liste d\'attente.', 'info');
  }

  function wireFillGapButton(button) {
    if (!button || button.dataset.fillGapWired === 'true') return;
    button.dataset.fillGapWired = 'true';

    button.addEventListener('click', async () => {
      const confirmed = await askConfirm('Remplacer le créneau avec un patient de la liste d\'attente ?');
      if (!confirmed) return;

      button.classList.add('is-loading');
      button.disabled = true;
      try {
        const response = await fetch(
          CONFIG.FILL_GAP_PROXY,
          { method: 'POST', credentials: 'include', headers: apiHeaders(), body: JSON.stringify({}) }
        );
        const payload = await response.json();
        if (!response.ok || payload?.ok === false) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }

        button.classList.add('is-success');
        toastFillGapResult(payload);
      } catch {
        showToast('Impossible de consulter la liste d\'attente. Réessayez.', 'error');
      } finally {
        button.classList.remove('is-loading');
        button.disabled = false;
        setTimeout(() => button.classList.remove('is-success'), 2500);
      }
    });
  }

  function wireFillGapButtons() {
    wireFillGapButton($('btn-super-fill-gap'));
    wireFillGapButton($('btn-fill-gap'));
  }

  function initForceTomorrowSms() {
    const button = $('btn-force-sms');
    if (!button || button.dataset.forceSmsWired === 'true') return;
    button.dataset.forceSmsWired = 'true';
    button.disabled = false;
    button.removeAttribute('aria-disabled');
    button.classList.remove('v-disabled');
    button.setAttribute('title', 'Rappel SMS pour les rendez-vous de demain');
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      const confirmed = await askConfirm(
        'Envoyer un rappel SMS à tous les patients de demain ? Cette action est irréversible.'
      );
      if (!confirmed) return;
      try {
        const result = await postBulkAction(CONFIG.ENDPOINTS.BULK_SMS, { action: 'force-tomorrow' });
        toastFromSmsResult(result);
      } catch (error) {
        console.error('[Force SMS] Failed:', error?.message || error);
        showToast("Échec de l'envoi SMS.", 'error');
      }
    });
  }

  function initQuickActions() {
    guardDeployingFeatureButtons();
    initForceTomorrowSms();
    wireFillGapButtons();
  }

  function isTypingField(element) {
    if (!element || !(element instanceof Element)) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (element.isContentEditable) return true;
    return false;
  }

  function clickAssistantNav(viewKey) {
    const link = assistantQuery(`.nav-link[data-nav="${viewKey}"]`);
    link?.click();
  }

  function initSuperpouvoirsAccordion() {
    const header = $('superpouvoirs-header');
    const accordion = $('superpouvoirs-accordion');
    if (!header || !accordion) return;

    const setOpen = (open) => {
      accordion.classList.toggle('is-open', open);
      header.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    const toggle = () => setOpen(!accordion.classList.contains('is-open'));

    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
  }

  function initKeyboardShortcuts() {
    if (!document.body.classList.contains('mode-assistant')) return;

    document.addEventListener('keydown', (event) => {
      const active = document.activeElement;
      const typing = isTypingField(active);
      const key = event.key.toLowerCase();
      const modKey = event.metaKey || event.ctrlKey;

      if (modKey && event.key === 'Enter' && active?.id === 'handoff-input') {
        event.preventDefault();
        document.querySelector('.handoff-compose__submit')?.click();
        return;
      }

      if (active?.closest('#superpouvoirs-header, [data-ghost-select], .ghost-select__list')) {
        return;
      }

      if (modKey && key === 'k') {
        if (typing) return;
        event.preventDefault();
        clickAssistantNav('crm');
        return;
      }

      if (typing) return;

      if (key === 'g' && !modKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        clickAssistantNav('overview');
        return;
      }

      if (event.code === 'Space' && !modKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        const search = $('crm-search');
        if (search) {
          if (activeView !== 'crm') clickAssistantNav('crm');
          requestAnimationFrame(() => {
            search.focus({ preventScroll: true });
          });
        } else {
          showToast('Recherche rapide…', 'info');
        }
      }
    });
  }

  function init() {
    bindCoreDelegation();

    const runInitStep = (label, fn) => {
      try {
        fn();
      } catch (error) {
        console.warn(`[DentaFlow] init step "${label}" failed:`, error?.message || error);
      }
    };

    runInitStep('settings', () => {
      loadSettings();
      applyTheme(volatileSettings.theme);
    });
    runInitStep('header', () => setHeaderDate());
    runInitStep('navigation', () => {
      initNavigation();
      initMobileNav();
    });
    runInitStep('superpouvoirs', () => {
      initSuperpouvoirsAccordion();
      initSuperpouvoirs();
    });
    runInitStep('keyboardShortcuts', () => initKeyboardShortcuts());
    runInitStep('status', () => initStatusListener());
    runInitStep('floorOps', () => initFloorComposer());
    runInitStep('quickActions', () => initQuickActions());
    runInitStep('bulkBar', () => initBulkActionBar());
    runInitStep('invisibleUI', () => initInvisibleUI());
    runInitStep('progressiveDisclosure', () => initProgressiveDisclosure());
    runInitStep('operationalPulse', () => {
      renderOperationalPulse(createEmptyOperationalPulse());
      refreshInvisibleUIDecorations($('assistant-pulse-grid'));
    });
    runInitStep('handoff', () => {
      initHandoffCategorySelect();
      loadHandoffNotes();
      initHandoffForm();
    });
    runInitStep('waitlist', () => {
      initWaitlistPrioritySelect();
      initWaitlistForm();
      initWaitlistUrgentToggle();
      loadWaitlistPanel();
    });
    runInitStep('profile', () => {
      initUserProfile();
      initAccountCardMenu();
    });
    runInitStep('settingsUI', () => {
      initSettings();
      initSettingsPrefsState();
      window.DentaFlowAuth?.bindPasswordForm?.(assistantRoot());
    });
    runInitStep('theme', () => initThemeSwitcher());
    runInitStep('crm', () => {
      initCrmSearch();
      initCrmSidePanel();
    });
    runInitStep('planning', () => loadPlanning());

    runInitStep('activeView', () => {
      const activeViewEl = $(VIEW_MAP[activeView]);
      if (activeViewEl) {
        activateDashboardView(activeViewEl, { animate: false });
      }
      if (activeView === 'calendar') {
        initDashboardCalendar();
      }
    });

    runInitStep('lucideIcons', () => {
      if (typeof window.refreshLucideIcons === 'function') {
        window.refreshLucideIcons(document.getElementById('assistant-mount') || document);
      }
    });
  }

  let assistantDashboardInitialized = false;

  function initializeAssistantDashboard() {
    if (assistantDashboardInitialized) return;
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
      if (window.DentaFlowAuth.isRestorePending?.()) return;
      void window.DentaFlowAuth.logout?.();
      return;
    }
    assistantDashboardInitialized = true;
    init();
  }

  window.initializeAssistantDashboard = initializeAssistantDashboard;
  window.bootAssistantApp = initializeAssistantDashboard;
  window.queueAssistantOsBootSequence = queueOsBootSequence;
  window.revealAssistantOsBootFallback = revealOsBootFallback;
  window.initProgressiveDisclosure = initProgressiveDisclosure;
  window.initInvisibleUI = initInvisibleUI;
  window.refreshInvisibleUIDecorations = refreshInvisibleUIDecorations;
  window.bindCoreDelegation = bindCoreDelegation;

  bindCoreDelegation();

  if (window.DentaFlowRowUI) {
    window.DentaFlowRowUI.createRowActionGroup = createRowActionGroup;
  }

  window.DentaFlowAuth?.registerLogoutTeardown?.(async function teardownAssistantSession() {
    assistantDashboardInitialized = false;
  });
})();
