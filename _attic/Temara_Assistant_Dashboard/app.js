/**
 * Assistant Command Center — n8n live data pipeline
 * Clinique Dentaire Témara Mall · DentaFlow OS
 */

const CONFIG = {
  ROSTER_PROXY: '/api/roster',
  DELAY_ALERT_PROXY: '/api/n8n-delay-alert',
  UPDATE_STATUS_PROXY: '/api/update-status',
  FILL_GAP_PROXY: '/api/fill-gap',
  TEAM_NOTES_PROXY: '/api/team-notes',
  PROXY: '/api/proxy',
  ENDPOINTS: {
    GET_ROSTER: '/api/roster',
    UPDATE_STATUS: '/api/update-status',
    EXPORT_DAILY: '/api/proxy',
    DELAY_ALERT: '/api/n8n-delay-alert',
    FORCE_REMINDERS: '/api/proxy',
    GET_NOTES: '/api/team-notes',
    POST_NOTE: '/api/team-notes',
    WAITLIST_ADD: '/api/waitlist',
    BULK_CONFIRM: '/api/proxy',
    BULK_CANCEL: '/api/proxy',
    BULK_SMS: '/api/bulk-sms',
  },
  PROXY_TARGETS: {
    EXPORT_DAILY: 'daily-report-export',
    FORCE_REMINDERS: 'force-reminders',
    BULK_CONFIRM: 'bulk-confirm',
    BULK_CANCEL: 'bulk-cancel',
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

const VIEW_MAP = {
  overview: 'view-overview',
  calendar: 'view-calendar',
  waitlist: 'view-waitlist',
  crm: 'view-crm',
  settings: 'view-settings',
};

const NOSHOW_SVG = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
      stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

const TREND_UP_SVG = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M7 17l5-5 3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M14 9h4v4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

const TREND_DOWN_SVG = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M7 7l5 5 3-3 5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M14 15h4v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

const SYSTEM_NOTE_SVG = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="5" y="8" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.75"/>
    <path d="M9 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
    <circle cx="9" cy="13" r="1" fill="currentColor"/>
    <circle cx="15" cy="13" r="1" fill="currentColor"/>
    <path d="M10 17h4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
  </svg>`;

const PIN_BADGE_SVG = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 17v5M9 3h6l1 7-4 2-4-2 1-7z" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

const OPERATIONAL_PULSE = {
  patientsSeen: 0,
  patientsPlanned: 0,
  cancellations: 0,
  punctuality: null,
  punctualityTrend: null,
  turnoverMinutes: null,
  turnoverTrend: null,
};

let handoffNotes = [];

(function () {
  'use strict';

  let toastTimer = null;
  let rosterData = [];
  let allRosterRecords = [];
  let crmPatientsById = {};
  let selectedPatientIds = [];
  let activeView = 'overview';
  let osBootSequencePlayed = false;

  function $(id) {
    const root = document.querySelector('.assistant-app-root') || document;
    if (root !== document) {
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

  function apiHeaders(extra = {}) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...extra,
    };
  }

  function askConfirm(message) {
    if (typeof window.DentaFlowConfirm?.confirmAction === 'function') {
      return window.DentaFlowConfirm.confirmAction(message);
    }
    return Promise.resolve(true);
  }

  /** GET roster — no Content-Type to avoid unnecessary CORS preflight on simple requests */
  function rosterFetchHeaders() {
    return {
      'Accept': 'application/json',
    };
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
    const [hours, minutes] = String(time || '00:00').split(':').map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }

  function sortHandoffNotes(notes) {
    return [...notes].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1;
      }
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
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderReadReceipts(readBy = []) {
    const avatars = readBy.slice(0, 3);
    if (!avatars.length) return '';

    return `
      <div class="handoff-note__receipts" aria-label="Lu par ${escapeHtml(avatars.join(', '))}">
        ${avatars.map((initials) => `
          <span class="handoff-note__avatar" title="${escapeHtml(initials)}">${escapeHtml(initials)}</span>
        `).join('')}
      </div>`;
  }

  function renderHandoffNote(note, options = {}) {
    const isSystem = note.type === 'system';
    const categorySlug = getHandoffCategorySlug(note.category);
    const enterClass = options.isNew ? ' is-entering' : '';

    const metaParts = [
      `<span class="handoff-note__category handoff-note__category--${categorySlug}">${escapeHtml(note.category || 'Info')}</span>`,
    ];

    if (isSystem) {
      metaParts.push(`
        <span class="handoff-note__system-icon" title="Événement système (n8n)" aria-label="Événement système">
          ${SYSTEM_NOTE_SVG}
        </span>`);
    } else if (note.author) {
      metaParts.push(`<span class="handoff-note__author">${escapeHtml(note.author)}</span>`);
    }

    if (note.time) {
      metaParts.push(`<time class="handoff-note__time" datetime="${escapeHtml(note.time)}">${escapeHtml(note.time)}</time>`);
    }

    if (note.pinned) {
      metaParts.push(`
        <span class="handoff-note__pin-badge" aria-label="Note épinglée">
          ${PIN_BADGE_SVG}
          Épinglé
        </span>`);
    }

    return `
      <article
        class="handoff-note handoff-note--${categorySlug}${note.pinned ? ' handoff-note--pinned' : ''}${isSystem ? ' handoff-note--system' : ''}${enterClass}"
        data-note-id="${note.id}"
        role="article"
      >
        <span class="handoff-note__dot handoff-note__dot--${categorySlug}" aria-hidden="true"></span>
        <div class="handoff-note__body">
          <div class="handoff-note__meta">${metaParts.join('')}</div>
          <p class="handoff-note__text">${escapeHtml(note.text)}</p>
        </div>
        ${renderReadReceipts(note.readBy)}
      </article>`;
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
      if (options.errorMessage) {
        feed.innerHTML = `<p class="handoff-feed__empty">${escapeHtml(options.errorMessage)}</p>`;
      } else if (!sorted.length) {
        feed.innerHTML = '<p class="handoff-feed__empty">Aucune note pour le moment. Ajoutez une transmission d\'équipe ci-dessus.</p>';
      } else {
        feed.innerHTML = sorted
          .map((note) => renderHandoffNote(note, { isNew: note.id === newestId && options.animate }))
          .join('');
      }

      feed.classList.remove('is-refreshing');
    });
  }

  function parseHandoffResponse(payload) {
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

  function normalizeHandoffRecord(raw) {
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

    const id =
      item.id ??
      item.ID ??
      `note-${String(text).slice(0, 24)}-${String(time || Date.now())}`;

    return {
      id,
      text,
      type: author ? 'manual' : 'system',
      category,
      pinned,
      author: author || undefined,
      time,
      readBy: Array.isArray(item.readBy) ? item.readBy : [],
    };
  }

  async function loadHandoffNotes() {
    const feed = $('handoff-feed');
    if (feed) {
      feed.innerHTML = '<p class="handoff-feed__empty">Chargement des transmissions…</p>';
    }

    try {
      const response = await fetch(
        CONFIG.ENDPOINTS.GET_NOTES,
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
      console.error('[Handoff] Load failed:', error);
      handoffNotes = [];
      renderHandoffBoard({
        errorMessage: 'Impossible de charger les transmissions — vérifiez la connexion n8n.',
      });
    }
  }

  function renderOperationalPulse() {
    const grid = $('assistant-pulse-grid');
    if (!grid) return;

    const data = OPERATIONAL_PULSE;
    const punctualityLabel = data.punctuality == null ? '—' : `${data.punctuality}%`;
    const turnoverLabel = data.turnoverMinutes == null ? '—' : `${data.turnoverMinutes} min`;
    const punctualityTrendClass = data.punctualityTrend === 'up' ? 'pulse-card__trend--up' : 'pulse-card__trend--down';
    const turnoverTrendClass = data.turnoverTrend === 'up' ? 'pulse-card__trend--up' : 'pulse-card__trend--down';
    const punctualityTrendSvg = data.punctualityTrend === 'up' ? TREND_UP_SVG : TREND_DOWN_SVG;
    const turnoverTrendSvg = data.turnoverTrend === 'up' ? TREND_UP_SVG : TREND_DOWN_SVG;

    grid.innerHTML = `
      <article class="pulse-card">
        <p class="pulse-card__label">Patients Vus / Prévus</p>
        <div class="pulse-card__value-row">
          <p class="pulse-card__value pulse-card__value--split">
            ${data.patientsSeen} <span>/ ${data.patientsPlanned}</span>
          </p>
        </div>
      </article>

      <article class="pulse-card">
        <p class="pulse-card__label">Annulations / No-Shows</p>
        <div class="pulse-card__value-row">
          <p class="pulse-card__value">${data.cancellations}</p>
        </div>
      </article>

      <article class="pulse-card">
        <p class="pulse-card__label">Taux de Ponctualité</p>
        <div class="pulse-card__value-row">
          <p class="pulse-card__value">${punctualityLabel}</p>
          ${data.punctualityTrend ? `<span class="pulse-card__trend ${punctualityTrendClass}" aria-label="Tendance">
            ${punctualityTrendSvg}
          </span>` : ''}
        </div>
      </article>

      <article class="pulse-card">
        <p class="pulse-card__label">Temps de Rotation Moyen</p>
        <div class="pulse-card__value-row">
          <p class="pulse-card__value">${turnoverLabel}</p>
          ${data.turnoverTrend ? `<span class="pulse-card__trend ${turnoverTrendClass}" aria-label="Tendance">
            ${turnoverTrendSvg}
          </span>` : ''}
        </div>
      </article>`;
  }

  function initHandoffForm() {
    const form = $('handoff-form');
    if (!form) return;

    form.addEventListener('submit', async (event) => {
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

      const profileName = (volatileSettings.profileName || DEFAULT_SETTINGS.profileName).trim();
      const author = profileName.split(/\s+/)[0] || profileName;
      const authorInitials = extractInitials(profileName);

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
      };

      handoffNotes.unshift(newNote);
      form.reset();
      renderHandoffBoard({ animate: true, highlightId: newNote.id });

      try {
        const response = await fetch(
          CONFIG.ENDPOINTS.POST_NOTE,
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
        console.error('[Handoff] POST failed:', error);
        handoffNotes = handoffNotes.filter(note => note.id !== tempId);
        renderHandoffBoard();
        showToast('Échec de la publication — réessayez.', 'error');
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

  function setSyncIndicator(state) {
    const dot = document.querySelector('.sync-dot');
    const label = document.querySelector('.sync-label');
    if (!dot || !label) return;
    dot.classList.remove('ok', 'loading', 'error');
    dot.classList.add(state);
    if (state === 'loading') label.textContent = 'Synchronisation en cours…';
    else if (state === 'error') label.textContent = 'Hors-ligne · Mode dégradé';
    else label.textContent = 'Synchronisé · Typebot actif';
  }

  /**
   * Extract HH:mm from Baserow "Date & Heure du RDV" (ISO datetime or parseable string).
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

    // n8n single-item wrapper: { json: { ... } }
    if (payload.json && typeof payload.json === 'object' && !Array.isArray(payload.json)) {
      return [payload.json];
    }

    // Object map of rows: { "0": {...}, "1": {...} }
    const values = Object.values(payload);
    if (values.length && values.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
      return values;
    }

    return [];
  }

  function unwrapRosterProxyPayload(payload) {
    if (payload && typeof payload === 'object' && payload.ok === false) {
      const detail = payload.details || payload.error || 'Erreur proxy roster';
      throw new Error(detail);
    }
    if (payload && typeof payload === 'object' && payload.ok === true && 'data' in payload) {
      const inner = payload.data;
      if (Array.isArray(inner)) return inner;
      if (looksLikeRosterRecord(inner)) return [inner];
      return parseRosterResponse(inner);
    }
    return payload;
  }

  /** Baserow single-select / lookup fields arrive as { id, value, color }. */
  function extractBaserowFieldValue(field) {
    if (field == null) return '';
    if (typeof field === 'string' || typeof field === 'number') return String(field);
    if (typeof field === 'object' && field.value != null) return String(field.value);
    return '';
  }

  function buildRosterPipeline(payload) {
    const unwrapped = unwrapRosterProxyPayload(payload);
    const n8nErr = getN8nWebhookErrorMessage(unwrapped);
    if (n8nErr) throw new Error(n8nErr);

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

  function getN8nWebhookErrorMessage(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (payload.code === 404 && String(payload.message || '').toLowerCase().includes('webhook')) {
      return 'Webhook n8n inactif — activez « Workflow 1 - Load Dashboard » dans n8n, puis réessayez.';
    }
    if (payload.code && payload.message) {
      return String(payload.message);
    }
    return null;
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

  function parseBaserowRowId(raw) {
    if (raw == null || raw === '') return null;
    const numericId = Number(raw);
    return Number.isFinite(numericId) ? numericId : null;
  }

  function extractBaserowRowId(record) {
    const id = record?.rowId ?? record?.id;
    return parseBaserowRowId(id);
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
      .map(extractBaserowRowId)
      .filter((rowId) => rowId != null);
  }

  function applyOptimisticBulkStatus(records, newStatus, badgeHtml, options = {}) {
    const { markRowCancelled = false, panelModifierClass = null } = options;
    const snapshots = [];

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
        el.innerHTML = badgeHtml;
      };

      const patchOuter = (el) => {
        if (!el) return;
        snapshot.dom.push({ mode: 'outer', parent: el.parentElement, html: el.outerHTML });
        el.outerHTML = badgeHtml;
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

      const rosterRow = document.querySelector(`#roster-tbody tr[data-patient-id="${id}"]`);
      if (rosterRow?.cells?.[4]) patchInner(rosterRow.cells[4]);
      patchRowCancelled(rosterRow);

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
        panelStatus.innerHTML = `<span class="status-pill__dot" aria-hidden="true"></span>${escapeHtml(newStatus)}`;
      }

      snapshots.push(snapshot);
    });

    return snapshots;
  }

  function applyOptimisticBulkConfirm(records) {
    return applyOptimisticBulkStatus(
      records,
      'Confirmé',
      buildCrmStatusBadge('Confirmé')
    );
  }

  function applyOptimisticBulkCancel(records) {
    return applyOptimisticBulkStatus(
      records,
      'Annulé',
      buildStatusPill('Annulé', 'status-pill--attente'),
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
        const direct = parseBaserowRowId(id);
        if (direct != null) return direct;
        const record = getRecordsForSelectedIds([id])[0];
        return record ? extractBaserowRowId(record) : null;
      })
      .filter((rowId) => rowId != null);
  }

  function isSameRowId(a, b) {
    return Number(a) === Number(b);
  }

  function restoreBulkSelection(ids) {
    selectedPatientIds = ids
      .map((id) => parseBaserowRowId(id))
      .filter((rowId) => rowId != null);
    document.querySelectorAll('#roster-tbody .row-checkbox').forEach((checkbox) => {
      const rowId = parseBaserowRowId(checkbox.dataset.rowId);
      checkbox.checked = rowId != null && selectedPatientIds.includes(rowId);
    });
    updateBulkBarUI();
  }

  async function postBulkAction(endpoint, payload) {
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

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 160)}`);
    }

    return response;
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
    document.querySelectorAll('#roster-tbody .row-checkbox').forEach((checkbox) => {
      checkbox.checked = false;
    });
    updateBulkBarUI();
  }

  function getRecordsForSelectedIds(ids = selectedPatientIds) {
    return ids
      .map((id) => {
        const rowId = parseBaserowRowId(id);
        if (rowId == null) return null;
        return rosterData.find((record) => isSameRowId(record.id, rowId))
          || allRosterRecords.find((record) => isSameRowId(record.id, rowId));
      })
      .filter(Boolean);
  }

  function removeRecordsFromLocalState(ids) {
    const idSet = new Set(
      ids.map((id) => String(parseBaserowRowId(id) ?? id))
    );
    rosterData = rosterData.filter((record) => !idSet.has(String(record.id)));
    allRosterRecords = allRosterRecords.filter((record) => !idSet.has(String(record.id)));
  }

  async function animateRowsVaporize(rowIds) {
    const rows = rowIds
      .map((id) => document.querySelector(`#roster-tbody tr[data-patient-id="${String(id)}"]`))
      .filter(Boolean);

    if (!rows.length) return;

    const removeRowsAndRelatedCards = () => {
      rows.forEach((row) => {
        const patientId = row.dataset.patientId;
        row.remove();
        document.querySelector(`.roster-card[data-patient-id="${patientId}"]`)?.remove();
      });

      const tbody = $('roster-tbody');
      if (tbody && !tbody.querySelector('tr:not(.roster-empty):not(.roster-loading):not(.roster-error)')) {
        tbody.innerHTML = `
          <tr class="roster-empty">
            <td colspan="5">${escapeHtml('Aucun rendez-vous prévu pour aujourd\'hui.')}</td>
          </tr>`;
      }

      const cards = $('roster-cards');
      if (cards && !cards.querySelector('.roster-card')) {
        cards.innerHTML = `<p class="roster-cards__empty">${escapeHtml('Aucun rendez-vous prévu pour aujourd\'hui.')}</p>`;
      }
    };

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced || typeof gsap === 'undefined') {
      removeRowsAndRelatedCards();
      return;
    }

    const cells = rows.flatMap((row) => Array.from(row.querySelectorAll('td')));

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
    const targetRowIds = getSelectedRowIdsForApi(ids);
    const optimisticSnapshots = applyOptimisticBulkConfirm(records);

    try {
      await postBulkAction(CONFIG.ENDPOINTS.BULK_CONFIRM, {
        target: CONFIG.PROXY_TARGETS.BULK_CONFIRM,
        rowIds: targetRowIds,
      });

      selectedPatientIds = [];
      document.querySelectorAll('#roster-tbody .row-checkbox').forEach((checkbox) => {
        checkbox.checked = false;
      });
      updateBulkBarUI();
      showToast(`${ids.length} rendez-vous confirmés avec succès`, 'success');
      loadPlanning();
    } catch (error) {
      console.error('[Bulk Confirm] Failed:', error);
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

    const targetRowIds = getSelectedRowIdsForApi(ids);
    const optimisticSnapshots = applyOptimisticBulkCancel(records);

    try {
      console.log('Payload sending:', { rowIds: targetRowIds });
      await Promise.all([
        postBulkAction(CONFIG.ENDPOINTS.BULK_CANCEL, {
          target: CONFIG.PROXY_TARGETS.BULK_CANCEL,
          rowIds: targetRowIds,
        }),
        animateRowsVaporize(ids),
      ]);

      removeRecordsFromLocalState(ids);
      updateRosterStats(rosterData);

      clearBulkSelection();
      showToast('Rendez-vous annulés avec succès', 'success');
    } catch (error) {
      console.error('[Bulk Cancel] Failed:', error);
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

    clearBulkSelection();
    showToast('Envoi des SMS en cours d\'exécution en arrière-plan...', 'info');

    try {
      console.log('Payload sending:', { rowIds: targetRowIds });
      await postBulkAction(CONFIG.ENDPOINTS.BULK_SMS, targetRowIds);
    } catch (error) {
      console.error('[Bulk SMS] Failed:', error);
      restoreBulkSelection(ids);
      showToast('Erreur: envoi SMS échoué.', 'error');
    }
  }

  function initBulkActionBar() {
    const tbody = $('roster-tbody');
    tbody?.addEventListener('change', (event) => {
      if (!event.target.classList.contains('row-checkbox')) return;

      const rowId = parseBaserowRowId(event.target.dataset.rowId);
      if (rowId == null) return;

      if (event.target.checked) {
        if (!selectedPatientIds.includes(rowId)) selectedPatientIds.push(rowId);
      } else {
        selectedPatientIds = selectedPatientIds.filter((id) => id !== rowId);
      }

      updateBulkBarUI();
    });

    $('btn-bulk-confirm')?.addEventListener('click', bulkConfirmSelected);
    $('btn-bulk-cancel')?.addEventListener('click', bulkCancelSelected);
    $('btn-bulk-sms')?.addEventListener('click', bulkSmsSelected);
  }

  function isAppointmentToday(rawDate) {
    if (rawDate == null || rawDate === '') return false;
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) return false;
    return parsed.toLocaleDateString('en-CA', { timeZone: 'Africa/Casablanca' }) === getTodayDateKey();
  }

  /** Planning du Jour — keep only today's appointments when dates are present. */
  function filterTodayRosterRecords(records) {
    const dated = records.filter(record => record.rawDate != null && record.rawDate !== '');
    if (!dated.length) return records;
    return records.filter(record => isAppointmentToday(record.rawDate));
  }

  function sortRosterByTime(records) {
    return [...records].sort((a, b) => {
      const timeA = a.rawDate ? new Date(a.rawDate).getTime() : Number.POSITIVE_INFINITY;
      const timeB = b.rawDate ? new Date(b.rawDate).getTime() : Number.POSITIVE_INFINITY;
      return timeA - timeB;
    });
  }

  function formatRosterErrorMessage(error) {
    const msg = String(error?.message || '');

    if (window.location.protocol === 'file:') {
      return 'Ouvrez le dashboard via un serveur HTTP local (Live Server, Vercel) — file:// bloque les appels API.';
    }

    if (msg.includes('not registered') || msg.includes('Webhook n8n inactif')) {
      return 'Webhook n8n inactif — activez « Workflow 1 - Load Dashboard » dans n8n, puis réessayez.';
    }
    if (/^HTTP 404\b/.test(msg) || msg.includes('HTTP 404')) {
      return 'Endpoint introuvable (HTTP 404) — le workflow n8n doit être publié et actif.';
    }
    if (/^HTTP 5\d{2}\b/.test(msg)) {
      return 'Erreur serveur n8n — réessayez dans quelques instants.';
    }
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return 'Impossible de charger le planning — Mode hors-ligne';
    }
    if (/réponse vide|respond to webhook|upstream timeout|webhook not registered/i.test(msg)) {
      return msg;
    }
    if (msg && msg.length <= 160) {
      return msg;
    }
    return 'Impossible de charger le planning — Mode hors-ligne';
  }

  /**
   * Normalize one roster row from Baserow/n8n — supports exact DB keys and aliases.
   */
  function normalizeRosterRecord(raw) {
    const item = raw?.json && typeof raw.json === 'object' && !Array.isArray(raw.json)
      ? raw.json
      : raw;

    if (!item || typeof item !== 'object') return null;

    const patientName =
      item['Patient (Nom Complet)'] ??
      item.Clean_Name ??
      item.Nom ??
      item.nom ??
      item.name ??
      'Non spécifié';

    const rawDate =
      item['Date & Heure du RDV'] ??
      item.startTime ??
      item.start_time ??
      item.datetime ??
      item.date;

    const treatment =
      item['Motif de Consultation'] ??
      item.motif ??
      item.treatment ??
      'Consultation';

    const statusRaw =
      item['Statut du RDV'] ??
      item.statut ??
      item.status;
    const statusValue = extractBaserowFieldValue(statusRaw);
    const status = statusValue || 'Confirmé';

    const calBookingId = String(item['Cal Booking ID'] ?? item.calBookingId ?? '').trim();

    const phone = String(
      item['Téléphone (WhatsApp)'] ??
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

    const baserowRowId = parseBaserowRowId(
      item.id ?? item.ID ?? item.row_id ?? item.rowId
    );

    const id = baserowRowId ?? `row-${String(patientName)}-${String(rawDate ?? '')}`;

    return {
      id,
      rowId: baserowRowId,
      name: String(patientName).trim() || 'Non spécifié',
      treatment: String(treatment).trim() || 'Consultation',
      status,
      calBookingId,
      phone,
      email,
      observations,
      time: formatAppointmentTime(rawDate),
      rawDate,
      noShow: Boolean(
        item['Historique No-Show'] ??
        item['Historique de no-shows'] ??
        item.noShow
      ),
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
    return `<span class="roster-noshow-flag" title="Historique de no-shows — vigilance recommandée" aria-label="Historique de no-shows">${NOSHOW_SVG}</span>`;
  }

  function buildStatusSelect(record) {
    const currentStatus = STATUS_OPTIONS.includes(record.status) ? record.status : 'Confirmé';
    const options = STATUS_OPTIONS.map(opt =>
      `<option value="${escapeHtml(opt)}"${opt === currentStatus ? ' selected' : ''}>${escapeHtml(opt)}</option>`
    ).join('');
    return `<select class="status-select" aria-label="Modifier le statut" data-booking-id="${escapeHtml(record.calBookingId || '')}">${options}</select>`;
  }

  function renderPlanning(records) {
    const rows = Array.isArray(records) ? records.filter(Boolean) : [];

    rosterData = rows.map(record => ({ ...record }));
    selectedPatientIds = [];

    updateRosterStats(rosterData);

    const emptyMessage = 'Aucun rendez-vous prévu pour aujourd\'hui.';

    const tbody = $('roster-tbody');
    if (tbody) {
      if (!rows.length) {
        tbody.innerHTML = `
          <tr class="roster-empty">
            <td colspan="5">${escapeHtml(emptyMessage)}</td>
          </tr>`;
      } else {
        tbody.innerHTML = rows.map(record => {
          const { id: patientId, name: patientName, treatment, status, time, noShow } = record;
          const baserowRowId = extractBaserowRowId(record);
          const rowIdAttr = baserowRowId != null ? String(baserowRowId) : '';

          return `
          <tr data-patient-id="${escapeHtml(patientId)}" data-id="${escapeHtml(patientId)}" class="${status === 'No-show' ? 'is-cancelled' : ''}">
            <td class="roster-checkbox-cell">
              <input type="checkbox" class="brutalist-checkbox row-checkbox" data-row-id="${rowIdAttr}" value="${rowIdAttr}" aria-label="Sélectionner ${escapeHtml(patientName)}"${baserowRowId == null ? ' disabled' : ''}>
            </td>
            <td class="roster-time">${escapeHtml(time)}</td>
            <td>
              <span class="roster-patient">
                ${noShow ? buildNoShowFlag() : ''}
                <span class="roster-patient__name">${escapeHtml(patientName)}</span>
              </span>
            </td>
            <td class="roster-treatment">${escapeHtml(treatment)}</td>
            <td>${buildStatusSelect(record)}</td>
          </tr>`;
        }).join('');
      }
    }

    updateBulkBarUI();

    const cards = $('roster-cards');
    if (cards) {
      if (!rows.length) {
        cards.innerHTML = `<p class="roster-cards__empty">${escapeHtml(emptyMessage)}</p>`;
      } else {
        cards.innerHTML = rows.map(record => {
          const { id: patientId, name: patientName, treatment, status, time, noShow } = record;

          return `
          <article class="roster-card ${status === 'No-show' ? 'is-cancelled' : ''}" data-patient-id="${escapeHtml(patientId)}">
            <span class="roster-time">${escapeHtml(time)}</span>
            <div class="roster-card__main">
              <span class="roster-patient">
                ${noShow ? buildNoShowFlag() : ''}
                <span class="roster-patient__name">${escapeHtml(patientName)}</span>
              </span>
              <div class="roster-card__meta">${escapeHtml(treatment)}</div>
            </div>
            ${buildStatusSelect(record)}
          </article>`;
        }).join('');
      }
    }

    if (activeView === 'overview' && osBootSequencePlayed) {
      restartViewStaggerAnimations($('view-overview'));
    }

    renderCRMTable(rows);
    if (rows.length) {
      updateCRMSidePanel(toCrmPatient(rows[0]));
    }
    hideSkeleton('roster');
    hideSkeleton('crm');
  }

  function showTableLoader() {
    showSkeleton('roster');
    showSkeleton('crm');
  }

  function showTableError(message = 'Impossible de charger le planning — Mode hors-ligne') {
    hideSkeleton('roster');
    hideSkeleton('crm');
    const safeMessage = escapeHtml(message);
    const tbody = $('roster-tbody');
    if (!tbody) return;
    tbody.innerHTML = `
      <tr class="roster-error">
        <td colspan="5">${safeMessage}</td>
      </tr>`;

    const cards = $('roster-cards');
    if (cards) {
      cards.innerHTML = `<p class="roster-cards__error">${safeMessage}</p>`;
    }

    updateRosterStats([]);
    setSyncIndicator('error');
  }

  async function fetchRosterPayload(url) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: rosterFetchHeaders(),
    });

    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();

    console.log('[Roster] HTTP', response.status, response.statusText, '|', url);
    console.log('[Roster] Content-Type:', contentType);
    console.log('[Roster] Raw body:', rawText);

    let payload;
    try {
      payload = rawText.trim() ? JSON.parse(rawText) : [];
    } catch (parseError) {
      throw new Error(`Réponse non-JSON (${contentType || 'unknown'}): ${parseError.message}`);
    }

    console.log('[Roster] Parsed JSON payload:', payload);

    if (!response.ok) {
      const n8nFromBody = getN8nWebhookErrorMessage(payload);
      throw new Error(n8nFromBody || `HTTP ${response.status}: ${rawText.slice(0, 200)}`);
    }

    const pipeline = buildRosterPipeline(payload);

    return { response, contentType, rawText, url, payload, pipeline };
  }

  async function loadPlanning() {
    showTableLoader();
    setSyncIndicator('loading');

    const primaryUrl = CONFIG.ROSTER_PROXY;
    console.log('[Roster] GET', primaryUrl);

    try {
      const result = await fetchRosterPayload(primaryUrl);

      const { rawRows, normalized, todayRecords } = result.pipeline;

      console.log('[Roster] Parsed rows:', rawRows.length, '| Normalized:', normalized.length, '| Today:', todayRecords.length);
      console.log('[Roster] Today records:', todayRecords);

      allRosterRecords = normalized;
      renderPlanning(todayRecords);
      setSyncIndicator('ok');
      queueOsBootSequence();
    } catch (error) {
      console.error('[Roster] Fetch failed:', error);

      showTableError(formatRosterErrorMessage(error));
      queueOsBootSequence();
    }
  }

  const OS_BOOT_SELECTORS = {
    sidebar: '.assistant-sidebar',
    pulseCards: '#assistant-pulse-grid .pulse-card',
    gridPanels: '#view-overview .assistant-grid .assistant-panel',
    dataRows: '#roster-tbody tr:not(.roster-empty):not(.roster-loading):not(.roster-error), #crm-table-body tr.crm-table-row',
  };

  function collectOsBootTargets() {
    return [
      document.querySelector(OS_BOOT_SELECTORS.sidebar),
      ...document.querySelectorAll(OS_BOOT_SELECTORS.pulseCards),
      ...document.querySelectorAll(OS_BOOT_SELECTORS.gridPanels),
      ...document.querySelectorAll(OS_BOOT_SELECTORS.dataRows),
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

    const sidebar = document.querySelector(OS_BOOT_SELECTORS.sidebar);
    const pulseCards = document.querySelectorAll(OS_BOOT_SELECTORS.pulseCards);
    const gridPanels = document.querySelectorAll(OS_BOOT_SELECTORS.gridPanels);
    const dataRows = document.querySelectorAll(OS_BOOT_SELECTORS.dataRows);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId, newStatus }),
      });

      const responseText = await response.text();
      let responsePayload = responseText;
      try {
        responsePayload = responseText ? JSON.parse(responseText) : null;
      } catch {
        // keep raw text
      }
      console.log('[Roster Status] Response:', {
        status: response.status,
        ok: response.ok,
        body: responsePayload,
      });

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
          if (otherSelect !== selectEl) otherSelect.value = newStatus;
        });
        const row = document.querySelector(`tr[data-patient-id="${patientId}"]`);
        const card = document.querySelector(`.roster-card[data-patient-id="${patientId}"]`);
        if (row) row.classList.toggle('is-cancelled', newStatus === 'No-show');
        if (card) card.classList.toggle('is-cancelled', newStatus === 'No-show');
      }

      setTimeout(() => {
        selectEl.classList.remove('status-success');
        selectEl.disabled = false;
      }, 2000);
    } catch (error) {
      console.error('[Roster Status] Update failed:', error);
      selectEl.value = previousStatus;
      selectEl.classList.remove('status-updating');
      selectEl.classList.add('status-error');
      selectEl.setAttribute('aria-invalid', 'true');
      selectEl.disabled = false;
      alert('Échec de la mise à jour du statut — réessayez.');
      setTimeout(() => {
        selectEl.classList.remove('status-error');
        selectEl.removeAttribute('aria-invalid');
      }, 2000);
    }
  }

  function initStatusListener() {
    const table = document.querySelector('.roster-table');
    const cards = $('roster-cards');

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
        void askConfirm(`Annuler le rendez-vous de ${name} ? Cette action est irréversible.`).then((ok) => {
          if (!ok) {
            select.value = previousStatus;
            return;
          }
          updateRosterStatus(select, previousStatus);
        });
        return;
      }
      updateRosterStatus(select, previousStatus);
    }

    table?.addEventListener('focusin', rememberPreviousStatus);
    cards?.addEventListener('focusin', rememberPreviousStatus);
    table?.addEventListener('change', handleChange);
    cards?.addEventListener('change', handleChange);
  }

  function initNavigation() {
    document.querySelectorAll('.nav-link[data-nav]').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        const nav = link.dataset.nav;
        if (nav && VIEW_MAP[nav]) navigateToView(nav);
      });
    });
  }

  function initMobileNav() {
    const root = document.querySelector('.assistant-app-root') || document.getElementById('assistant-shell');
    const btn = (root || document).querySelector('#mobile-menu-btn');
    const drawer = (root || document).querySelector('#mobile-drawer');
    const closeBtn = (root || document).querySelector('#mobile-close-btn');
    if (!btn || !drawer) return;

    function toggleMenu(open) {
      drawer.classList.toggle('open', open);
      drawer.setAttribute('aria-hidden', String(!open));
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
      document.body.classList.toggle('mobile-drawer-open', open);
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu(!drawer.classList.contains('open'));
    });
    closeBtn?.addEventListener('click', () => toggleMenu(false));

    document.addEventListener('click', (e) => {
      if (drawer.classList.contains('open') && !drawer.contains(e.target) && !btn.contains(e.target)) {
        toggleMenu(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') toggleMenu(false);
    });

    drawer.querySelectorAll('.nav-link[data-nav]').forEach((link) => {
      link.addEventListener('click', () => toggleMenu(false));
    });
  }

  const VIEW_TRANSITION_MS = 400;
  const SETTINGS_STORAGE_KEY = 'dentaflow_assistant_prefs';

  const DEFAULT_SETTINGS = {
    theme: 'oak-lounge',
    profileName: 'Sanae Amrani',
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
          theme: normalizeTheme(parsed.theme),
          profileName: parsed.profileName ?? DEFAULT_SETTINGS.profileName,
          profileSpecialty: parsed.profileSpecialty ?? DEFAULT_SETTINGS.profileSpecialty,
          smsReminders: parsed.smsReminders !== false,
          emailReminders: parsed.emailReminders !== false,
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

    document.querySelectorAll('.dashboard-view').forEach(view => {
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
  function navigateToView(viewKey) {
    const targetId = VIEW_MAP[viewKey];
    if (!targetId || viewKey === activeView) return;

    const targetView = document.getElementById(targetId);
    if (!targetView) return;

    activateDashboardView(targetView, { animate: true });

    document.querySelectorAll('.nav-link[data-nav]').forEach(link => {
      const isActive = link.dataset.nav === viewKey;
      link.classList.toggle('is-active', isActive);
      if (isActive) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

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
    if (el) el.textContent = text ?? '—';
  }

  let dashboardCalendar = null;

  function initDashboardCalendar() {
    const el = $('dashboard-cal-inline');
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
        left: 'prev,next today',
        center: 'title',
        right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
      },
      locale: 'fr',
      firstDay: 1,
      height: 'auto',
      expandRows: true,
      slotMinTime: '08:00:00',
      slotMaxTime: '19:00:00',
      nowIndicator: true,
      allDaySlot: false,
      events: [],
      eventTimeFormat: {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      },
    });

    dashboardCalendar.render();
  }

  function buildApptCardHTML(appt) {
    return `
      <div class="appt-card">
        <span class="appt-time">${appt.time}</span>
        <div class="appt-info">
          <div class="appt-name">${appt.name}</div>
          <span class="appt-tag appt-tag--${appt.tagClass}">${appt.treatment}</span>
        </div>
      </div>`;
  }

  function renderWaitlistPanel() {
    const container = $('waitlist-panel-list');
    if (!container) return;
    const waitlist = [];
    container.innerHTML = waitlist.map(buildApptCardHTML).join('');
    if (!waitlist.length) {
      container.textContent = '';
      const empty = document.createElement('p');
      empty.className = 'schedule-empty';
      empty.textContent = 'Aucun patient en liste d\'attente';
      container.appendChild(empty);
    }
    hideSkeleton('waitlist');
  }

  function setWaitlistFormProcessing(form, isProcessing) {
    form.querySelectorAll('.waitlist-input, .waitlist-select').forEach((field) => {
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

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const btn = $('waitlist-submit-btn');
      const nameEl = $('waitlist-name');
      const phoneEl = $('waitlist-phone');
      const priorityEl = $('waitlist-priority');
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
        priorityEl.value = 'Normale';
        prependWaitlistEntry({
          nom: patientName,
          priorite: patientPriority,
        });
        showToast('Patient ajouté à la liste d\'attente avec succès', 'success');
      } catch (error) {
        console.error('[Waitlist] Submission failed:', error);
        showToast('Échec de la connexion au serveur. Veuillez réessayer.', 'error');
      } finally {
        btn.innerHTML = defaultBtnHtml;
        btn.disabled = false;
        setWaitlistFormProcessing(form, false);
      }
    });
  }

  function prependWaitlistEntry({ nom, priorite }) {
    const container = $('waitlist-panel-list');
    if (!container) return;

    const tagClass = priorite === 'Haute' ? 'urgence' : 'consultation';
    container.insertAdjacentHTML('afterbegin', buildApptCardHTML({
      time: 'Nouveau',
      name: nom,
      treatment: priorite,
      tagClass,
    }));
  }

  function applyTheme(theme) {
    const resolved = normalizeTheme(theme);
    document.documentElement.setAttribute('data-theme', resolved);
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
    oakBtn.addEventListener('click', () => applyTheme('oak-lounge'));
    pearlBtn.addEventListener('click', () => applyTheme('pearl-clinic'));
  }

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
    const displayName = (name ?? '').trim() || DEFAULT_SETTINGS.profileName;
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
    const saved = loadSettings();
    const nameEl = $('settings-profile-name');
    const specialtyEl = $('settings-profile-specialty');

    const profileName = saved.profileName ?? DEFAULT_SETTINGS.profileName;
    const profileSpecialty = saved.profileSpecialty ?? DEFAULT_SETTINGS.profileSpecialty;

    if (nameEl) nameEl.value = profileName;
    if (specialtyEl) specialtyEl.value = profileSpecialty;

    applyUserProfile(profileName, profileSpecialty);

    function persistProfile() {
      const name = nameEl?.value.trim() || DEFAULT_SETTINGS.profileName;
      const specialty = specialtyEl?.value.trim() || DEFAULT_SETTINGS.profileSpecialty;
      saveSettings({ profileName: name, profileSpecialty: specialty });
      applyUserProfile(name, specialty);
    }

    nameEl?.addEventListener('input', persistProfile);
    specialtyEl?.addEventListener('input', persistProfile);
    nameEl?.addEventListener('change', persistProfile);
    specialtyEl?.addEventListener('change', persistProfile);
  }

  function initSettings() {
    const saved = loadSettings();
    const smsToggle = $('settings-sms-toggle');
    const emailToggle = $('settings-email-toggle');

    if (smsToggle) smsToggle.checked = saved.smsReminders !== false;
    if (emailToggle) emailToggle.checked = saved.emailReminders !== false;

    smsToggle?.addEventListener('change', () => saveSettings({ smsReminders: smsToggle.checked }));
    emailToggle?.addEventListener('change', () => saveSettings({ emailReminders: emailToggle.checked }));
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
    return {
      id: record.id,
      name: record.name || 'Non spécifié',
      phone: record.phone || '',
      email: record.email || '',
      motif: record.treatment || 'Consultation',
      status: record.status || 'Confirmé',
      observations: record.observations || '',
      lastVisit: formatCrmLastVisit(record.rawDate),
    };
  }

  function buildStatusPill(label, modifierClass = '') {
    const safeLabel = escapeHtml(label || '—');
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
    setText('crm-panel-phone', patientData.phone || 'Non renseigné');
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
      statusEl.innerHTML = `<span class="status-pill__dot" aria-hidden="true"></span>${escapeHtml(statusLabel)}`;
    }
  }

  function renderCRMTable(appointmentsArray) {
    const tbody = document.getElementById('crm-table-body');
    if (!tbody) return;

    const rows = Array.isArray(appointmentsArray) ? appointmentsArray.filter(Boolean) : [];
    crmPatientsById = {};
    tbody.innerHTML = '';

    if (!rows.length) {
      tbody.innerHTML = `
        <tr class="crm-table-empty">
          <td colspan="5">Aucun patient pour aujourd'hui.</td>
        </tr>`;
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

      tr.innerHTML = `
        <td>${escapeHtml(patient.name)}</td>
        <td>${escapeHtml(patient.phone || 'Non renseigné')}</td>
        <td>${escapeHtml(patient.email || '—')}</td>
        <td>${buildMotifPill(patient.motif)}</td>
        <td>${buildCrmStatusBadge(patient.status)}</td>`;

      tr.addEventListener('click', () => activateCrmRow(tr));

      tbody.appendChild(tr);
    });

    const firstRow = tbody.querySelector('.crm-table-row');
    if (firstRow) firstRow.classList.add('active-row');
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
      status: dataset.statut ?? row.cells[4]?.textContent.trim() ?? 'Confirmé',
      lastVisit: dataset.lastVisit ?? 'Non renseigné',
      observations: dataset.observations ?? '',
    };
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

    document.querySelectorAll('.crm-table-row.active-row').forEach((row) => {
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

    document.querySelectorAll('.crm-table-row.active-row').forEach((row) => {
      row.classList.remove('active-row');
    });
  }

  function initCrmSearch() {
    const searchEl = $('crm-search');
    const tbody = $('crm-table-body');
    if (!searchEl || !tbody) return;

    searchEl.addEventListener('input', () => {
      const query = searchEl.value.trim().toLowerCase();
      tbody.querySelectorAll('tr').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.classList.toggle('is-hidden', query.length > 0 && !text.includes(query));
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

    tbody.addEventListener('keydown', (event) => {
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

  function initQuickActions() {
    const btnReport    = $('btn-daily-report');
    const btnFillGap   = $('btn-fill-gap');
    const btnDelay     = $('btn-alerte-retard');
    const btnReminders = $('btn-force-reminders');

    btnReport?.addEventListener('click', async () => {
      btnReport.classList.add('is-loading');
      btnReport.disabled = true;
      try {
        const response = await fetch(
          CONFIG.ENDPOINTS.EXPORT_DAILY,
          {
            method: 'POST',
            credentials: 'include',
            headers: apiHeaders(),
            body: JSON.stringify({ target: CONFIG.PROXY_TARGETS.EXPORT_DAILY }),
          }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `rapport-journalier-${new Date().toISOString().slice(0, 10)}.xlsx`;
        link.click();
        URL.revokeObjectURL(url);

        btnReport.classList.add('is-success');
        showToast('Rapport journalier généré — téléchargement lancé.', 'success');
      } catch {
        showToast('Export indisponible — vérifiez le workflow n8n.', 'error');
      } finally {
        btnReport.classList.remove('is-loading');
        btnReport.disabled = false;
        setTimeout(() => btnReport.classList.remove('is-success'), 2500);
      }
    });

    btnFillGap?.addEventListener('click', async () => {
      const confirmed = await askConfirm('Remplacer le créneau avec un patient de la liste d\'attente ?');
      if (!confirmed) return;

      btnFillGap.classList.add('is-loading');
      btnFillGap.disabled = true;
      try {
        const response = await fetch(
          CONFIG.FILL_GAP_PROXY,
          { method: 'POST', credentials: 'include', headers: apiHeaders() }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        btnFillGap.classList.add('is-success');
        showToast('Blast SMS envoyé à la liste d\'attente.', 'success');
      } catch {
        showToast('Échec de l\'envoi SMS — réessayez.', 'error');
      } finally {
        btnFillGap.classList.remove('is-loading');
        btnFillGap.disabled = false;
        setTimeout(() => btnFillGap.classList.remove('is-success'), 2500);
      }
    });

    btnDelay?.addEventListener('click', async () => {
      console.log('Alerte Retard button clicked');

      const labelEl = btnDelay.querySelector('.btn-super__label');
      const defaultLabel = labelEl?.textContent?.trim() || 'Alerte Retard Praticien';
      const successLabel = 'Alerte Envoyée ✓';
      const feedbackMs = 3000;

      btnDelay.disabled = true;
      btnDelay.classList.add('is-loading');

      try {
        const response = await fetch(CONFIG.DELAY_ALERT_PROXY, {
          method: 'POST',
          credentials: 'include',
          headers: apiHeaders(),
        });

        const responseText = await response.text();
        let responsePayload = responseText;
        try {
          responsePayload = responseText ? JSON.parse(responseText) : null;
        } catch {
          // keep raw text for logging
        }
        console.log('[Delay Alert] Response:', {
          status: response.status,
          ok: response.ok,
          body: responsePayload,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${String(responseText).slice(0, 200)}`);
        }

        if (labelEl) labelEl.textContent = successLabel;
        btnDelay.classList.remove('is-loading');
        btnDelay.classList.add('is-success');
        showToast('Alerte SMS envoyée avec succès.', 'success');

        setTimeout(() => {
          if (labelEl) labelEl.textContent = defaultLabel;
          btnDelay.disabled = false;
          btnDelay.classList.remove('is-success');
        }, feedbackMs);
      } catch (error) {
        console.error('[Delay Alert] Request failed:', error);
        btnDelay.disabled = false;
        btnDelay.classList.remove('is-loading', 'is-success');
        showToast('Échec de l\'alerte retard — réessayez.', 'error');
      }
    });

    btnReminders?.addEventListener('click', async () => {
      const confirmed = await askConfirm('Forcer l\'envoi des rappels maintenant ?');
      if (!confirmed) return;

      btnReminders.classList.add('is-loading');
      btnReminders.disabled = true;
      try {
        const response = await fetch(
          CONFIG.ENDPOINTS.FORCE_REMINDERS,
          {
            method: 'POST',
            credentials: 'include',
            headers: apiHeaders(),
            body: JSON.stringify({ target: CONFIG.PROXY_TARGETS.FORCE_REMINDERS }),
          }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        btnReminders.classList.add('is-success');
        showToast('Rappels SMS envoyés avec succès.', 'success');
      } catch {
        showToast('Échec de l\'envoi des rappels — réessayez.', 'error');
      } finally {
        btnReminders.classList.remove('is-loading');
        btnReminders.disabled = false;
        setTimeout(() => btnReminders.classList.remove('is-success'), 2500);
      }
    });
  }

  function init() {
    loadSettings();
    applyTheme(volatileSettings.theme);
    setHeaderDate();
    initNavigation();
    initMobileNav();
    initStatusListener();
    initQuickActions();
    initBulkActionBar();
    renderOperationalPulse();
    loadHandoffNotes();
    initHandoffForm();
    initWaitlistForm();
    initSettings();
    initThemeSwitcher();
    initUserProfile();
    initCrmSearch();
    initCrmSidePanel();
    renderWaitlistPanel();
    loadPlanning();

    const activeViewEl = document.getElementById(VIEW_MAP[activeView]);
    if (activeViewEl) {
      activateDashboardView(activeViewEl, { animate: false });
    }

    if (activeView === 'calendar') {
      initDashboardCalendar();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeBootAssistant);
  } else {
    maybeBootAssistant();
  }

  function maybeBootAssistant() {
    if (document.body.classList.contains('auth-gate-active')) return;
    if (sessionStorage.getItem('dentaflow_role') === 'assistant') {
      init();
    }
  }

  window.bootAssistantApp = init;
})();
