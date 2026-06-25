/**
 * Assistant Command Center — n8n live data pipeline
 * Clinique Dentaire Témara Mall · DentaFlow OS
 */

(function () {
  'use strict';

const CONFIG = {
  API_BASE: 'https://glade-rigor-perennial.ngrok-free.dev',
  ROSTER_PROXY: '/api/roster',
  DELAY_ALERT_PROXY: '/api/n8n-delay-alert',
  UPDATE_STATUS_PROXY: '/api/update-status',
  FILL_GAP_PROXY: '/api/fill-gap',
  ENDPOINTS: {
    GET_ROSTER: '/webhook/assistant-data',
    UPDATE_STATUS: '/webhook/update-status',
    EXPORT_DAILY: '/webhook/daily-report-export',
    DELAY_ALERT: '/webhook/doctor-delayed',
    FORCE_REMINDERS: '/webhook/force-reminders',
    GET_NOTES: '/webhook/get-notes',
    POST_NOTE: '/webhook/post-note',
    WAITLIST_ADD: '/webhook/waitlist-add',
    BULK_CONFIRM: '/webhook/bulk-confirm',
    BULK_CANCEL: '/webhook/bulk-cancel',
    BULK_SMS: '/webhook/bulk-sms',
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

const PLANNING_UPSTREAM_ERROR_MESSAGE =
  'Erreur de connexion au serveur (503). Veuillez rafraîchir la page ou contacter le support.';

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
    patientsSeen: 0,
    patientsPlanned: 0,
    cancellations: 0,
    punctuality: null,
    turnoverMinutes: null,
  };
}

function computeOperationalPulse(records) {
  const rows = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!rows.length) return createEmptyOperationalPulse();

  return {
    patientsSeen: rows.filter((record) => isPulseSeenStatus(record.status)).length,
    patientsPlanned: rows.length,
    cancellations: rows.filter((record) => isPulseCancelledStatus(record.status)).length,
    punctuality: null,
    turnoverMinutes: null,
  };
}

let handoffNotes = [];

  let toastTimer = null;
  let rosterData = [];
  let allRosterRecords = [];
  let crmPatientsById = {};
  let selectedPatientIds = [];
  let activeView = 'overview';
  let osBootSequencePlayed = false;

  function $(id) {
    return document.getElementById(id);
  }

  function apiHeaders(extra = {}) {
    const authHeaders = typeof window.DentaFlowAuth?.getAuthHeaders === 'function'
      ? window.DentaFlowAuth.getAuthHeaders()
      : { Accept: 'application/json' };

    return {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
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
      'ngrok-skip-browser-warning': 'true',
      ...authHeaders,
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
      systemIcon.title = 'Événement système (n8n)';
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

    const textP = document.createElement('p');
    textP.className = 'handoff-note__text';
    textP.textContent = note.text || '';

    body.append(meta, textP);
    article.append(dot, body);

    const receipts = createReadReceiptsElement(note.readBy);
    if (receipts) article.appendChild(receipts);

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
          'Aucune note pour le moment. Ajoutez une transmission d\'équipe ci-dessus.'
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
      feed.replaceChildren();
      window.DentaFlowDom?.appendParagraph(feed, 'handoff-feed__empty', 'Chargement des transmissions…');
    }

    try {
      const response = await fetch(
        `${CONFIG.API_BASE}${CONFIG.ENDPOINTS.GET_NOTES}`,
        { method: 'GET', headers: rosterFetchHeaders() }
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

  function renderOperationalPulse(pulseData = createEmptyOperationalPulse()) {
    return safeRender('renderOperationalPulse', () => {
    const grid = $('assistant-pulse-grid');
    if (!grid) return;

    const data = pulseData ?? createEmptyOperationalPulse();
    const punctualityLabel = data.punctuality != null ? `${data.punctuality}%` : '--';
    const turnoverLabel = data.turnoverMinutes != null ? `${data.turnoverMinutes} min` : '--';

    grid.innerHTML = `
      <article class="pulse-card">
        <p class="pulse-card__label" data-tooltip="Patients déjà reçus sur le total prévu aujourd'hui">Patients Vus / Prévus</p>
        <div class="pulse-card__value-row">
          <p class="pulse-card__value pulse-card__value--split">
            ${data.patientsSeen} <span>/ ${data.patientsPlanned}</span>
          </p>
        </div>
      </article>

      <article class="pulse-card">
        <p class="pulse-card__label" data-tooltip="Annulations et absences non signalées du jour">Annulations / No-Shows</p>
        <div class="pulse-card__value-row">
          <p class="pulse-card__value">${data.cancellations}</p>
        </div>
      </article>

      <article class="pulse-card">
        <p class="pulse-card__label" data-tooltip="Pourcentage de patients arrivés à l'heure">Taux de Ponctualité</p>
        <div class="pulse-card__value-row">
          <p class="pulse-card__value">${punctualityLabel}</p>
        </div>
      </article>

      <article class="pulse-card">
        <p class="pulse-card__label" data-tooltip="Durée moyenne entre l'arrivée et le début du soin">Temps de Rotation Moyen</p>
        <div class="pulse-card__value-row">
          <p class="pulse-card__value">${turnoverLabel}</p>
        </div>
      </article>`;
    });
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
          `${CONFIG.API_BASE}${CONFIG.ENDPOINTS.POST_NOTE}`,
          {
            method: 'POST',
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

  function fillStatusPillElement(node, label, modifierClass = '') {
    node.className = ['status-pill', modifierClass].filter(Boolean).join(' ');
    if (window.DentaFlowDom?.setStatusPill) {
      window.DentaFlowDom.setStatusPill(node, label);
    } else {
      node.replaceChildren();
      node.appendChild(document.createTextNode(label || '—'));
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
        const direct = parseBaserowRowId(id);
        if (direct != null) return direct;
        const record = getRecordsForSelectedIds([id])[0];
        return record ? extractBaserowRowId(record) : null;
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
    const rowId = extractBaserowRowId(record);
    return {
      rowId,
      calBookingId: row?.dataset?.calBookingId || record.calBookingId || '',
      scheduleDate: String(row?.dataset?.scheduleDate ?? formatScheduleDate(record.rawDate)).trim(),
      startTime: String(row?.dataset?.startTime ?? record.time ?? '').trim(),
      practitioner: String(row?.dataset?.practitioner ?? record.practitioner ?? 'Dr. Tazi').trim(),
    };
  }

  function getSelectedBulkCancelPayload(ids = selectedPatientIds) {
    const records = getRecordsForSelectedIds(ids);
    const appointments = records
      .map(extractCancelMetadataFromRecord)
      .filter((entry) => entry.rowId != null);

    return {
      rowIds: appointments.map((entry) => entry.rowId),
      calBookingIds: appointments.map((entry) => entry.calBookingId || ''),
      appointments: appointments.map((entry) => ({
        ...entry,
        calBookingId: entry.calBookingId || '',
      })),
    };
  }

  function isSameRowId(a, b) {
    return Number(a) === Number(b);
  }

  function restoreBulkSelection(ids) {
    selectedPatientIds = ids
      .map((id) => parseBaserowRowId(id))
      .filter((rowId) => rowId != null);
    document.querySelectorAll('#planning-timeline .row-checkbox, #roster-tbody .row-checkbox').forEach((checkbox) => {
      const rowId = parseBaserowRowId(checkbox.dataset.rowId);
      checkbox.checked = rowId != null && selectedPatientIds.includes(rowId);
    });
    updateBulkBarUI();
  }

  async function postBulkAction(endpoint, payload) {
    const body = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload
      : { rowIds: payload };

    const response = await fetch(
      `${CONFIG.API_BASE}${endpoint}`,
      {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify(body),
      }
    );

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
    const targetRowIds = getSelectedRowIdsForApi(ids);
    const optimisticSnapshots = applyOptimisticBulkConfirm(records);

    try {
      await postBulkAction(CONFIG.ENDPOINTS.BULK_CONFIRM, targetRowIds);

      selectedPatientIds = [];
      document.querySelectorAll('#planning-timeline .row-checkbox, #roster-tbody .row-checkbox').forEach((checkbox) => {
        checkbox.checked = false;
      });
      updateBulkBarUI();
      animateInlineConfirmSuccess(ids);
      showToast(`${ids.length} rendez-vous confirmés avec succès`, 'success');
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
    const cancelPayload = getSelectedBulkCancelPayload(ids);
    const optimisticSnapshots = applyOptimisticBulkCancel(records);

    try {
      console.log('Payload sending:', cancelPayload);
      const [cancelResult] = await Promise.all([
        postBulkAction(CONFIG.ENDPOINTS.BULK_CANCEL, cancelPayload),
        animateRowsVaporize(ids),
      ]);

      removeRecordsFromLocalState(ids);
      updateRosterStats(rosterData);

      clearBulkSelection();
      if (cancelResult?.status === 'partial_success') {
        showToast(
          cancelResult.message || 'Annulé en base uniquement (patient sans ID Calendrier).',
          'warning'
        );
      } else {
        showToast('Rendez-vous annulés avec succès', 'success');
      }
    } catch (error) {
      console.error('[Bulk Cancel] Failed:', error);
      revertOptimisticBulkSnapshots(optimisticSnapshots);
      loadPlanning();
      showToast('Erreur: Annulation échouée.', 'error');
    }
  }

  async function bulkSmsSelected() {
    if (!selectedPatientIds.length) return;

    const ids = [...selectedPatientIds];
    const targetRowIds = getSelectedRowIdsForApi(ids);
    const btnBulkSms = $('btn-bulk-sms');

    clearBulkSelection();
    showToast('Envoi des SMS en cours d\'exécution en arrière-plan...', 'info');

    btnBulkSms?.classList.add('is-loading');
    if (btnBulkSms) btnBulkSms.disabled = true;

    try {
      console.log('Payload sending:', { rowIds: targetRowIds });
      const result = await postBulkAction(CONFIG.ENDPOINTS.BULK_SMS, { rowIds: targetRowIds });
      const message = result?.message || 'SMS groupés envoyés avec succès.';
      showToast(message, 'success');
    } catch (error) {
      console.error('[Bulk SMS] Failed:', error);
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

    const rowId = parseBaserowRowId(event.target.dataset.rowId);
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
    let msg = String(error?.message || '').trim();
    msg = parseUpstreamErrorDetail(msg) || msg;

    if (window.location.protocol === 'file:') {
      return 'Ouvrez le dashboard via un serveur HTTP local (Live Server, Vercel) — file:// bloque les appels API.';
    }

    if (/service unavailable|upstream http error|upstream timeout|upstream error/i.test(msg)) {
      return PLANNING_UPSTREAM_ERROR_MESSAGE;
    }
    if (/503/.test(msg)) {
      return PLANNING_UPSTREAM_ERROR_MESSAGE;
    }
    if (msg.includes('not registered') || msg.includes('Webhook n8n inactif')) {
      return 'Webhook n8n inactif — activez « Workflow 1 - Load Dashboard » dans n8n, puis réessayez.';
    }
    if (/^HTTP 404\b/.test(msg) || msg.includes('HTTP 404')) {
      return 'Endpoint introuvable (HTTP 404) — le workflow n8n doit être publié et actif.';
    }
    if (/^HTTP 5\d{2}\b/.test(msg)) {
      return PLANNING_UPSTREAM_ERROR_MESSAGE;
    }
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return 'Impossible de charger le planning — Mode hors-ligne';
    }
    if (/réponse vide|respond to webhook|webhook not registered/i.test(msg)) {
      return msg;
    }
    if (msg.startsWith('{') && msg.includes('"error"')) {
      return PLANNING_UPSTREAM_ERROR_MESSAGE;
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

    const insurance = String(
      item['N° d\'Assurance'] ??
      item['Couverture Médicale'] ??
      item.insurance ??
      ''
    ).trim();

    const practitioner = String(
      item['Praticien Assigné'] ??
      item['Praticien'] ??
      item.practitioner ??
      'Dr. Tazi'
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
      insurance,
      practitioner,
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

  function getMatteChipModifier(label) {
    const n = (label ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    if (n.includes('urgence')) return 'urgence';
    if (n.includes('confirm')) return 'confirmé';
    if (n.includes('annul') || n.includes('no-show')) return 'annulé';
    if (n.includes('attente') || n.includes('soin')) return 'attente';
    if (n.includes('termin')) return 'confirmé';
    return 'attente';
  }

  function applyMatteSelectSkin(selectEl, status) {
    if (!selectEl) return;
    selectEl.dataset.matte = getMatteChipModifier(status ?? selectEl.value);
  }

  function createMatteChip(label) {
    const chip = document.createElement('span');
    chip.className = `matte-chip matte-chip--${getMatteChipModifier(label)}`;
    chip.textContent = label || '—';
    return chip;
  }

  function createPatientAvatar(name) {
    const avatar = document.createElement('span');
    avatar.className = 'patient-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = extractInitials(name);
    return avatar;
  }

  function createPatientIdentity(name, options = {}) {
    const { showNoShow = false, hasNotes = false } = options;
    const wrap = document.createElement('div');
    wrap.className = 'patient-identity';

    wrap.appendChild(createPatientAvatar(name));

    const labelWrap = document.createElement('span');
    labelWrap.className = 'patient-identity__name';

    if (showNoShow) {
      const flagSpan = document.createElement('span');
      flagSpan.className = 'roster-noshow-flag';
      flagSpan.dataset.tooltip = 'Historique de no-shows — vigilance recommandée';
      flagSpan.setAttribute('aria-label', 'Historique de no-shows');
      flagSpan.innerHTML = NOSHOW_SVG;
      labelWrap.appendChild(flagSpan);
      labelWrap.appendChild(document.createTextNode(' '));
    }

    const nameText = document.createElement('span');
    nameText.textContent = name || '';
    if (name) {
      nameText.classList.add('cell-truncate');
      nameText.dataset.tooltip = name;
    }
    labelWrap.appendChild(nameText);

    if (hasNotes) {
      labelWrap.classList.add('has-notes');
      const indicator = document.createElement('span');
      indicator.className = 'notes-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      indicator.dataset.tooltip = 'Notes internes disponibles';
      labelWrap.appendChild(indicator);
    }

    wrap.appendChild(labelWrap);
    return wrap;
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

  function getWaitlistPriorityLabel(appt) {
    if (appt.statusLabel) return appt.statusLabel;
    const treatment = String(appt.treatment ?? appt.priorite ?? '').toLowerCase();
    if (appt.tagClass === 'urgence' || treatment === 'haute') return 'Urgence';
    return 'En attente';
  }

  const ROW_ACTION_SVG = {
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    sms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  };

  const EMPTY_STATE_SVG_CALENDAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';

  const EMPTY_STATE_SVG_INBOX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

  const EMPTY_STATE_DEFAULT_MESSAGE = 'Aucun rendez-vous. En attente de nouvelles réservations.';

  const emptyStatePulseTweens = new WeakMap();

  function createRowActionButton(action, label, svgMarkup, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-action-btn';
    btn.dataset.action = action;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = svgMarkup;
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
      .catch(() => showToast('Copie impossible — sélectionnez le numéro manuellement.', 'error'));
  }

  async function sendQuickSmsToRow(rowId) {
    const parsed = parseBaserowRowId(rowId);
    if (parsed == null) {
      showToast('SMS rapide indisponible pour cette ligne.', 'warning');
      return;
    }
    try {
      await postBulkAction(CONFIG.ENDPOINTS.BULK_SMS, { rowIds: [parsed] });
      showToast('SMS envoyé.', 'success');
    } catch (error) {
      console.error('[Quick SMS] Failed:', error);
      showToast('Échec de l\'envoi SMS.', 'error');
    }
  }

  function prefillWaitlistFormFromRow(appt) {
    const nameEl = $('waitlist-name');
    const phoneEl = $('waitlist-phone');
    const priorityEl = $('waitlist-priority');
    if (nameEl) nameEl.value = appt.name || '';
    if (phoneEl) phoneEl.value = appt.phone || appt.telephone || '';
    if (priorityEl && appt.priorite) priorityEl.value = appt.priorite;
  }

  function createRowActionGroup(context) {
    const group = document.createElement('div');
    group.className = 'action-group';
    group.setAttribute('aria-label', 'Actions secondaires');

    const phone = context.phone || context.telephone || context.record?.phone || '';

    if (context.kind === 'waitlist') {
      group.append(
        createRowActionButton('edit', 'Modifier le patient', ROW_ACTION_SVG.edit, () => {
          prefillWaitlistFormFromRow(context.appt || context);
          if (VIEW_MAP.waitlist) navigateToView('waitlist');
          $('waitlist-name')?.focus();
        }),
        createRowActionButton('sms', 'Envoyer un SMS rapide', ROW_ACTION_SVG.sms, () => {
          showToast('Notification SMS planifiée via n8n.', 'info');
        }),
        createRowActionButton('copy', 'Copier le numéro', ROW_ACTION_SVG.copy, () => {
          copyTextToClipboard(phone);
        })
      );
      return group;
    }

    const record = context.record || {};
    const rowId = extractBaserowRowId(record);

    group.append(
      createRowActionButton('edit', 'Modifier le statut', ROW_ACTION_SVG.edit, () => {
        const row = document.querySelector(`[data-patient-id="${String(record.id)}"] .status-select`);
        row?.focus();
      }),
      createRowActionButton('sms', 'Envoyer un SMS rapide', ROW_ACTION_SVG.sms, () => {
        if (rowId != null) sendQuickSmsToRow(rowId);
        else showToast('SMS rapide indisponible pour ce rendez-vous.', 'warning');
      }),
      createRowActionButton('copy', 'Copier les informations', ROW_ACTION_SVG.copy, () => {
        copyTextToClipboard(`${record.name || ''} — ${record.time || ''}`);
      })
    );
    return group;
  }

  function createEmptyState(options = {}) {
    const {
      message = EMPTY_STATE_DEFAULT_MESSAGE,
      iconSvg = EMPTY_STATE_SVG_CALENDAR,
    } = options;

    const wrap = document.createElement('div');
    wrap.className = 'empty-state';

    const icon = document.createElement('div');
    icon.className = 'empty-state__icon';
    icon.innerHTML = iconSvg;

    const text = document.createElement('p');
    text.className = 'empty-state__text';
    text.textContent = message;

    wrap.append(icon, text);
    return wrap;
  }

  function mountEmptyState(hostId, options = {}) {
    const host = $(hostId);
    if (!host) return null;

    host.replaceChildren();
    const state = createEmptyState(options);
    host.appendChild(state);
    host.hidden = false;
    initEmptyStatePulse(state);
    return state;
  }

  function clearEmptyState(hostId) {
    const host = $(hostId);
    if (!host) return;
    const icon = host.querySelector('.empty-state__icon');
    if (icon && typeof gsap !== 'undefined') {
      gsap.killTweensOf(icon);
    }
    host.replaceChildren();
    host.hidden = true;
  }

  function initEmptyStatePulse(emptyStateEl) {
    if (!emptyStateEl || typeof gsap === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const icon = emptyStateEl.querySelector('.empty-state__icon');
    if (!icon) return;

    const existing = emptyStatePulseTweens.get(icon);
    if (existing) existing.kill();

    gsap.set(icon, { opacity: 0.1 });
    const tween = gsap.to(icon, {
      opacity: 0.3,
      duration: 1.5,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
    });
    emptyStatePulseTweens.set(icon, tween);
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
    popover.style.top = `${rect.bottom + gap}px`;
    popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    popover.style.left = 'auto';
    popover.style.bottom = 'auto';
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
        const trigger = event.target.closest('.btn-icon-menu');
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

  function initRowActionHover() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let activeRow = null;

    document.addEventListener('mouseover', (event) => {
      const row = event.target.closest('[data-row-interactive]');
      if (!row || row === activeRow) return;
      if (activeRow && !activeRow.contains(event.relatedTarget)) {
        animateRowActionGroup(activeRow.querySelector('.action-group'), false);
      }
      activeRow = row;
      animateRowActionGroup(row.querySelector('.action-group'), true);
    });

    document.addEventListener('mouseout', (event) => {
      const row = event.target.closest('[data-row-interactive]');
      if (!row || row.contains(event.relatedTarget)) return;
      animateRowActionGroup(row.querySelector('.action-group'), false);
      if (activeRow === row) activeRow = null;
    });
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
      const rosterFill = $('btn-fill-gap');
      if (rosterFill) {
        rosterFill.click();
        return;
      }

      fillBtn.disabled = true;
      try {
        const response = await fetch(CONFIG.FILL_GAP_PROXY, {
          method: 'POST',
          headers: apiHeaders(),
          body: JSON.stringify({}),
        });
        const payload = await response.json();
        if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
        showToast('Blast SMS envoyé à la liste d\'attente.', 'success');
      } catch {
        showToast('Échec de l\'envoi SMS — réessayez.', 'error');
      } finally {
        fillBtn.disabled = false;
      }
      });
    }

    if (exportBtn && exportBtn.dataset.adminWired !== 'true') {
      exportBtn.dataset.adminWired = 'true';
      exportBtn.addEventListener('click', async () => {
      const rosterExport = $('btn-daily-report');
      if (rosterExport) {
        rosterExport.click();
        return;
      }

      exportBtn.disabled = true;
      try {
        const response = await fetch(
          `${CONFIG.API_BASE}${CONFIG.ENDPOINTS.EXPORT_DAILY}`,
          { method: 'GET', headers: apiHeaders() }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `rapport-journalier-${new Date().toISOString().slice(0, 10)}.xlsx`;
        link.click();
        URL.revokeObjectURL(url);
        showToast('Rapport journalier généré.', 'success');
      } catch {
        showToast('Export indisponible.', 'error');
      } finally {
        exportBtn.disabled = false;
      }
      });
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

  function createCopyableSpan(value, displayLabel) {
    const span = document.createElement('span');
    const raw = String(value || '').trim();
    span.className = 'copyable';
    span.dataset.value = raw;
    span.textContent = displayLabel ?? (raw || '—');
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.setAttribute('aria-label', `Copier ${span.textContent}`);
    if (raw) span.dataset.tooltip = 'Cliquer pour copier';
    return span;
  }

  function setCopyableField(elementId, value, fallback = '—') {
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
        showToast('Copie impossible — sélectionnez la valeur manuellement.', 'error');
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
      console.warn(`[DentaFlow] ${label} failed:`, error);
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
        else phoneCell.textContent = '—';
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
    return `<select class="status-select" aria-label="Modifier le statut" data-booking-id="${escapeHtml(record.calBookingId || '')}">${options}</select>`;
  }

  function createStatusSelectElement(record) {
    const select = document.createElement('select');
    select.className = 'status-select';
    select.setAttribute('aria-label', 'Modifier le statut');
    if (record.calBookingId) {
      select.dataset.bookingId = String(record.calBookingId);
    }
    const currentStatus = STATUS_OPTIONS.includes(record.status) ? record.status : 'Confirmé';
    STATUS_OPTIONS.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      if (opt === currentStatus) option.selected = true;
      select.appendChild(option);
    });
    applyMatteSelectSkin(select, currentStatus);
    return select;
  }

  function createPlanningTimelineItem(record) {
    const patientId = String(record.id);
    const baserowRowId = extractBaserowRowId(record);
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
    if (baserowRowId != null) {
      checkbox.dataset.rowId = String(baserowRowId);
      checkbox.value = String(baserowRowId);
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
    }));

    const treatment = document.createElement('div');
    treatment.className = 'timeline-item__treatment cell-truncate';
    treatment.textContent = record.treatment || '';
    if (record.treatment) treatment.dataset.tooltip = record.treatment;
    main.appendChild(treatment);

    const meta = document.createElement('div');
    meta.className = 'timeline-item__meta';

    meta.appendChild(createRowActionGroup({ kind: 'planning', record }));

    const statusWrap = document.createElement('div');
    statusWrap.className = 'timeline-item__status';
    statusWrap.appendChild(createStatusSelectElement(record));

    meta.appendChild(statusWrap);
    card.append(checkboxWrap, main, meta);
    item.append(timeEl, rail, card);
    return item;
  }

  /** @deprecated Legacy table row — kept for backward compatibility */
  function createRosterTableRow(record) {
    const patientId = String(record.id);
    const baserowRowId = extractBaserowRowId(record);
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
    if (baserowRowId != null) {
      checkbox.dataset.rowId = String(baserowRowId);
      checkbox.value = String(baserowRowId);
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
      flagSpan.title = 'Historique de no-shows — vigilance recommandée';
      flagSpan.setAttribute('aria-label', 'Historique de no-shows');
      flagSpan.innerHTML = NOSHOW_SVG;
      patientWrap.appendChild(flagSpan);
    }
    const nameSpan = document.createElement('span');
    nameSpan.className = 'roster-patient__name';
    nameSpan.textContent = record.name || '';
    patientWrap.appendChild(nameSpan);
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
    main.appendChild(createPatientIdentity(record.name, { showNoShow: record.noShow }));

    const meta = document.createElement('div');
    meta.className = 'roster-card__meta cell-truncate';
    meta.textContent = record.treatment || '';
    if (record.treatment) meta.title = record.treatment;

    main.appendChild(meta);
    article.append(timeSpan, main, createStatusSelectElement(record));
    return article;
  }

  function createWaitlistTableRow(appt) {
    const tr = document.createElement('tr');
    tr.className = 'waitlist-row';
    tr.dataset.rowInteractive = 'true';

    const patientTd = document.createElement('td');
    patientTd.colSpan = 1;

    const rowInner = document.createElement('div');
    rowInner.className = 'waitlist-row__inner';

    const main = document.createElement('div');
    main.className = 'waitlist-row__main';
    main.appendChild(createPatientIdentity(appt.name));

    rowInner.append(
      main,
      createRowActionGroup({
        kind: 'waitlist',
        appt,
        phone: appt.phone || appt.telephone,
        priorite: appt.priorite || appt.treatment,
      })
    );
    patientTd.appendChild(rowInner);

    const phoneTd = document.createElement('td');
    phoneTd.className = 'col-numeric';
    const phoneValue = String(appt.phone || appt.telephone || '').trim();
    if (phoneValue) {
      phoneTd.appendChild(createCopyableSpan(phoneValue));
    } else {
      phoneTd.textContent = '—';
    }

    const priorityTd = document.createElement('td');
    priorityTd.appendChild(createMatteChip(getWaitlistPriorityLabel(appt)));

    tr.append(patientTd, phoneTd, priorityTd);
    return tr;
  }

  function renderPlanning(records) {
    return safeRender('renderPlanning', () => {
    const rows = Array.isArray(records) ? records.filter(Boolean) : [];

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
    refreshInvisibleUIDecorations($('assistant-pulse-grid'));
    });
  }

  function showTableLoader() {
    const timeline = $('planning-timeline');
    if (timeline) {
      timeline.replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'timeline-loading planning-timeline__message';
      const inner = document.createElement('span');
      inner.className = 'roster-loading__inner';
      const spinner = document.createElement('span');
      spinner.className = 'roster-loading__spinner';
      spinner.setAttribute('aria-hidden', 'true');
      inner.append(spinner, document.createTextNode('Chargement du planning…'));
      loading.appendChild(inner);
      timeline.appendChild(loading);
    }

    const tbody = $('roster-tbody');
    if (tbody) {
      tbody.replaceChildren();
      const tr = document.createElement('tr');
      tr.className = 'roster-loading';
      const td = document.createElement('td');
      td.colSpan = 5;
      const inner = document.createElement('span');
      inner.className = 'roster-loading__inner';
      const spinner = document.createElement('span');
      spinner.className = 'roster-loading__spinner';
      spinner.setAttribute('aria-hidden', 'true');
      inner.append(spinner, document.createTextNode('Chargement du planning…'));
      td.appendChild(inner);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    const cards = $('roster-cards');
    if (cards) {
      cards.replaceChildren();
      const loading = document.createElement('p');
      loading.className = 'roster-cards__loading';
      loading.textContent = 'Chargement du planning…';
      cards.appendChild(loading);
    }
  }

  function showTableError(message = 'Impossible de charger le planning — Mode hors-ligne') {
    const friendlyMessage = typeof message === 'string' && message.includes('Erreur de connexion au serveur')
      ? message
      : formatRosterErrorMessage({ message });

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
    refreshInvisibleUIDecorations($('assistant-pulse-grid'));
    setSyncIndicator('error');
  }

  async function fetchRosterPayload(url) {
    const response = await fetch(url, {
      method: 'GET',
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
    dataRows: '#planning-timeline .timeline-item:not(.timeline-empty):not(.timeline-loading):not(.timeline-error), #waitlist-panel-list tr:not(.waitlist-empty), #crm-table-body tr.crm-table-row',
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
      const token = window.DentaFlowAuth?.getToken?.();
      if (!token) {
        throw new Error('Session expirée — veuillez vous reconnecter.');
      }

      const response = await fetch(CONFIG.UPDATE_STATUS_PROXY, {
        method: 'POST',
        headers: apiHeaders(),
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

      if (response.status === 401) {
        window.DentaFlowAuth?.clearSession?.();
        throw new Error('Session expirée — veuillez vous reconnecter.');
      }

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
      console.error('[Roster Status] Update failed:', error);
      selectEl.value = previousStatus;
      applyMatteSelectSkin(selectEl, previousStatus);
      selectEl.classList.remove('status-updating');
      selectEl.classList.add('status-error');
      selectEl.disabled = false;
      const msg = String(error?.message || '');
      if (msg.includes('Session expirée')) {
        alert('Session expirée — veuillez vous reconnecter.');
      } else {
        alert('Échec de la mise à jour du statut — réessayez.');
      }
      setTimeout(() => selectEl.classList.remove('status-error'), 2000);
    }
  }

  function initStatusListener() {
    const timeline = $('planning-timeline');
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
      updateRosterStatus(select, previousStatus);
    }

    timeline?.addEventListener('focusin', rememberPreviousStatus);
    table?.addEventListener('focusin', rememberPreviousStatus);
    cards?.addEventListener('focusin', rememberPreviousStatus);
    timeline?.addEventListener('change', handleChange);
    table?.addEventListener('change', handleChange);
    cards?.addEventListener('change', handleChange);
  }

  function initNavigation() {
    document.querySelectorAll('.nav-link[data-nav]').forEach(link => {
      link?.addEventListener('click', event => {
        event.preventDefault();
        const nav = link.dataset.nav;
        if (nav && VIEW_MAP[nav]) navigateToView(nav);
      });
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
      buildWeekEvent(1, 9, 0, 45, 'Consultation — Youssef Benali'),
      buildWeekEvent(2, 10, 30, 60, 'Blanchiment — Amina El Fassi'),
      buildWeekEvent(3, 14, 0, 45, 'Consultation — Fatima Zahra'),
      buildWeekEvent(4, 11, 15, 30, 'Urgence — Karim Alami'),
    ];
  }

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
      events: getDashboardDemoEvents(),
      eventTimeFormat: {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      },
    });

    dashboardCalendar.render();
  }

  function getDemoWaitlistPatients() {
    return [
      { name: 'Fatima Zahra', phone: '+212 661 234 567', treatment: 'Haute', tagClass: 'urgence', priority: 1, statusLabel: 'Urgence' },
      { name: 'Youssef Benali', phone: '+212 612 987 654', treatment: 'Haute', tagClass: 'urgence', priority: 1, statusLabel: 'Urgence' },
      { name: 'Amina El Fassi', phone: '+212 678 445 120', treatment: 'Normale', tagClass: 'consultation', priority: 2, statusLabel: 'En attente' },
      { name: 'Salma Berrada', phone: '+212 655 332 891', treatment: 'Normale', tagClass: 'consultation', priority: 2, statusLabel: 'En attente' },
    ];
  }

  function createApptCardElement(appt) {
    return createWaitlistTableRow(appt);
  }

  function renderWaitlistPanel() {
    return safeRender('renderWaitlistPanel', () => {
    const container = $('waitlist-panel-list');
    if (!container) return;
    const waitlist = getDemoWaitlistPatients().sort((a, b) => a.priority - b.priority);
    container.replaceChildren();

    const table = container.closest('.waitlist-table');
    if (!waitlist.length) {
      mountEmptyState('waitlist-empty-state', {
        message: EMPTY_STATE_DEFAULT_MESSAGE,
        iconSvg: EMPTY_STATE_SVG_INBOX,
      });
      if (table) table.hidden = true;
      return;
    }

    clearEmptyState('waitlist-empty-state');
    if (table) table.hidden = false;

    const fragment = document.createDocumentFragment();
    waitlist.forEach((appt) => fragment.appendChild(createWaitlistTableRow(appt)));
    container.appendChild(fragment);
    refreshInvisibleUIDecorations(container);
    });
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

    form?.addEventListener('submit', async (event) => {
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

      if (!patientName || !patientPhone) {
        showToast('Veuillez renseigner le nom et le numéro de téléphone.', 'warning');
        if (!patientName) nameEl.focus();
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
          `${CONFIG.API_BASE}${CONFIG.ENDPOINTS.WAITLIST_ADD}`,
          {
            method: 'POST',
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
          telephone: patientPhone,
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

  function prependWaitlistEntry({ nom, telephone, priorite }) {
    const container = $('waitlist-panel-list');
    if (!container) return;

    clearEmptyState('waitlist-empty-state');
    const table = container.closest('.waitlist-table');
    if (table) table.hidden = false;

    const tagClass = priorite === 'Haute' ? 'urgence' : 'consultation';
    const row = createWaitlistTableRow({
      name: nom,
      phone: telephone || '—',
      treatment: priorite,
      tagClass,
      priorite,
    });
    container.prepend(row);
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
    oakBtn?.addEventListener('click', () => applyTheme('oak-lounge'));
    pearlBtn?.addEventListener('click', () => applyTheme('pearl-clinic'));
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
      insurance: record.insurance || '',
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
      const emptyRow = document.createElement('tr');
      emptyRow.className = 'crm-table-empty';
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.textContent = 'Aucun patient pour aujourd\'hui.';
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
      emailCell.textContent = patient.email || '—';

      const motifCell = document.createElement('td');
      motifCell.appendChild(createStatusPillElement(
        patient.motif || 'Consultation',
        'status-pill--neutral'
      ));

      const statusCell = document.createElement('td');
      statusCell.appendChild(createStatusPillElement(
        patient.status || 'Confirmé',
        getCrmStatutTagClass(patient.status)
      ));

      tr.append(nameCell, phoneCell, emailCell, motifCell, statusCell);
      tbody.appendChild(tr);
    });

    const firstRow = tbody.querySelector('.crm-table-row');
    if (firstRow) firstRow.classList.add('active-row');
    refreshInvisibleUIDecorations(tbody);
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
      status: dataset.statut ?? row.cells[4]?.textContent.trim() ?? 'Confirmé',
      lastVisit: dataset.lastVisit ?? 'Non renseigné',
      observations: dataset.observations ?? '',
      insurance: dataset.insurance ?? '',
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

    searchEl?.addEventListener('input', () => {
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
          `${CONFIG.API_BASE}${CONFIG.ENDPOINTS.EXPORT_DAILY}`,
          { method: 'GET', headers: apiHeaders() }
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
      btnFillGap.classList.add('is-loading');
      btnFillGap.disabled = true;
      try {
        const response = await fetch(
          CONFIG.FILL_GAP_PROXY,
          { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) }
        );
        const payload = await response.json();
        if (!response.ok || payload?.ok === false) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }

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
      const defaultLabel = labelEl?.textContent?.trim() || btnDelay.textContent?.trim() || 'Alerte Retard Praticien';
      const successLabel = 'Alerte Envoyée ✓';
      const feedbackMs = 3000;

      btnDelay.disabled = true;
      btnDelay.classList.add('is-loading');

      try {
        const response = await fetch(CONFIG.DELAY_ALERT_PROXY, {
          method: 'POST',
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
        else btnDelay.textContent = successLabel;
        btnDelay.classList.remove('is-loading');
        btnDelay.classList.add('is-success');
        showToast('Alerte SMS envoyée avec succès.', 'success');

        setTimeout(() => {
          if (labelEl) labelEl.textContent = defaultLabel;
          else btnDelay.textContent = defaultLabel;
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
      btnReminders.classList.add('is-loading');
      btnReminders.disabled = true;
      try {
        const response = await fetch(
          `${CONFIG.API_BASE}${CONFIG.ENDPOINTS.FORCE_REMINDERS}`,
          { method: 'POST', headers: apiHeaders() }
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
    bindCoreDelegation();

    const runInitStep = (label, fn) => {
      try {
        fn();
      } catch (error) {
        console.warn(`[DentaFlow] init step "${label}" failed:`, error);
      }
    };

    runInitStep('settings', () => {
      loadSettings();
      applyTheme(volatileSettings.theme);
    });
    runInitStep('header', () => setHeaderDate());
    runInitStep('navigation', () => initNavigation());
    runInitStep('status', () => initStatusListener());
    runInitStep('quickActions', () => initQuickActions());
    runInitStep('bulkBar', () => initBulkActionBar());
    runInitStep('invisibleUI', () => initInvisibleUI());
    runInitStep('progressiveDisclosure', () => initProgressiveDisclosure());
    runInitStep('operationalPulse', () => {
      renderOperationalPulse(createEmptyOperationalPulse());
      refreshInvisibleUIDecorations($('assistant-pulse-grid'));
    });
    runInitStep('handoff', () => {
      loadHandoffNotes();
      initHandoffForm();
    });
    runInitStep('waitlist', () => {
      initWaitlistForm();
      renderWaitlistPanel();
    });
    runInitStep('settingsUI', () => initSettings());
    runInitStep('theme', () => initThemeSwitcher());
    runInitStep('profile', () => initUserProfile());
    runInitStep('crm', () => {
      initCrmSearch();
      initCrmSidePanel();
    });
    runInitStep('planning', () => loadPlanning());

    runInitStep('activeView', () => {
      const activeViewEl = document.getElementById(VIEW_MAP[activeView]);
      if (activeViewEl) {
        activateDashboardView(activeViewEl, { animate: false });
      }
      if (activeView === 'calendar') {
        initDashboardCalendar();
      }
    });
  }

  let assistantDashboardInitialized = false;

  function initializeAssistantDashboard() {
    if (assistantDashboardInitialized) return;
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

  window.DentaFlowRowUI = {
    createRowActionGroup,
    createWaitlistTableRow,
    createCopyableSpan,
    createEmptyState,
    mountEmptyState,
    clearEmptyState,
    initEmptyStatePulse,
    EMPTY_STATE_DEFAULT_MESSAGE,
    EMPTY_STATE_SVG_INBOX,
  };
})();
