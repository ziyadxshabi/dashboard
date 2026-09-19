/**
 * Shared Carnet patients — doctor + assistant.
 * All-time patients directory via GET /api/roster?directory=1, year/month timeline, iOS detail sheet.
 */
(function (global) {
  'use strict';

  const ROSTER_URL = '/api/roster';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const MONTH_LABELS = [
    'Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin',
    'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.',
  ];

  let groups = [];
  let groupsById = {};
  let years = [];
  let months = [];
  let selectedYear = null;
  let selectedMonth = null;
  let searchTimer = null;
  let letterFilter = '';
  const boundRoots = new WeakSet();
  const sheetSelects = {
    insurance: null,
    beneficiary: null,
    relation: null,
  };

  function storageKey() {
    const role = document.body.classList.contains('mode-assistant') ? 'assistant' : 'doctor';
    return `dentaflow:carnet-period:${role}`;
  }

  function readStoredPeriod() {
    try {
      const raw = sessionStorage.getItem(storageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      selectedYear = Number.isInteger(parsed?.year) ? parsed.year : null;
      selectedMonth = Number.isInteger(parsed?.month) ? parsed.month : null;
    } catch {
      selectedYear = null;
      selectedMonth = null;
    }
  }

  function writeStoredPeriod() {
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify({
        year: selectedYear,
        month: selectedMonth,
      }));
    } catch {
      /* ignore quota / private mode */
    }
  }

  function carnetRoot() {
    if (document.body.classList.contains('mode-assistant')) {
      return document.getElementById('assistant-mount')
        || document.getElementById('assistant-shell')
        || document;
    }
    return document.getElementById('doctor-shell') || document;
  }

  function $(id) {
    const root = carnetRoot();
    if (root && root !== document) {
      return root.querySelector('[id="' + String(id).replace(/"/g, '\\"') + '"]');
    }
    return document.getElementById(id);
  }

  function authHeaders(extra) {
    const auth = typeof global.DentaFlowAuth?.getAuthHeaders === 'function'
      ? global.DentaFlowAuth.getAuthHeaders()
      : { Accept: 'application/json' };
    return { ...auth, ...extra };
  }

  function assertAuthorized(response) {
    if (typeof global.DentaFlowAuth?.assertAuthorizedResponse === 'function') {
      return global.DentaFlowAuth.assertAuthorizedResponse(response);
    }
    return response;
  }

  function formatWhen(row) {
    const raw = row?.starts_at || row?.last_starts_at || row?.rawDate || row?.startTime;
    const parsed = raw ? new Date(raw) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return row?.time || '';
    return parsed.toLocaleString('fr-FR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Africa/Casablanca',
    });
  }

  function formatDay(raw) {
    const parsed = raw ? new Date(raw) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Africa/Casablanca',
    });
  }

  function madLabel(value, rows) {
    if (rows === 0) return '—';
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '—';
    return `${Math.round(n)} MAD`;
  }

  function letterFor(name) {
    const ch = String(name || '').trim().charAt(0).toLocaleUpperCase('fr-FR');
    return LETTERS.includes(ch) ? ch : '#';
  }

  function mapPatient(row) {
    const lastWhen = row.last_starts_at ? formatWhen({ starts_at: row.last_starts_at }) : '';
    return {
      id: row.patient_id || row.id,
      patient_id: row.patient_id || row.id,
      name: row.name || row.display_name || 'Non spécifié',
      phone: row.phone || row.phone_e164 || '',
      email: row.email || '',
      allergies: row.allergies || '',
      chronic_conditions: row.chronic_conditions || '',
      preferred_anesthetic: row.preferred_anesthetic || '',
      last_xray_on: row.last_xray_on || '',
      clinical_notes: row.clinical_notes || '',
      sms_consent: row.sms_consent === true,
      insurance: row.insurance || '',
      insurance_type: row.insurance_type || row.insuranceType || '',
      insurance_member_number: row.insurance_member_number || row.insuranceMemberNumber || '',
      mutuelle_name: row.mutuelle_name || row.mutuelleName || '',
      beneficiary_of_patient_id: row.beneficiary_of_patient_id || row.beneficiaryOfPatientId || '',
      beneficiary_name: row.beneficiary_name || row.beneficiaryName || '',
      beneficiary_relation: row.beneficiary_relation || row.beneficiaryRelation || '',
      last_starts_at: row.last_starts_at || null,
      lastWhen,
      motif: row.last_treatment || '',
      statut: row.last_status || '',
      honoraires_saisis: row.honoraires_saisis,
      honoraires_rows: Number(row.honoraires_rows) || 0,
      noshow_count: Number(row.noshow_count) || 0,
      letter: letterFor(row.name || row.display_name),
      visits: [],
    };
  }

  function listHost() {
    return $('crm-book-list') || $('crm-table-body');
  }

  function setEmpty(visible, title, message) {
    const host = $('crm-empty-state');
    const layout = carnetRoot().querySelector('#view-crm .carnet-book-layout');
    const scroll = carnetRoot().querySelector('#view-crm .crm-book-scroll, #view-crm .crm-table-scroll');
    if (host) {
      host.hidden = !visible;
      const t = host.querySelector('.ios-empty__title');
      const m = host.querySelector('.ios-empty__text');
      if (t && title) t.textContent = title;
      if (m && message) m.textContent = message;
    }
    if (layout) layout.hidden = Boolean(visible);
    if (scroll) scroll.hidden = Boolean(visible);
  }

  function emptyCopy() {
    const q = $('crm-search')?.value.trim() || '';
    if (q) {
      return {
        title: 'Aucun patient trouvé',
        message: `Aucun dossier ne correspond à « ${q} ».`,
      };
    }
    if (selectedYear || selectedMonth) {
      return {
        title: 'Aucun patient cette période',
        message: 'Choisissez une autre année, un autre mois, ou Tous.',
      };
    }
    return {
      title: 'Aucun dossier au fichier',
      message: 'Les patients apparaissent ici dès qu’un dossier est créé.',
    };
  }

  function visibleGroups() {
    if (!letterFilter) return groups;
    return groups.filter((patient) => patient.letter === letterFilter);
  }

  function renderTimeline() {
    const yearHost = $('crm-timeline-years');
    const monthHost = $('crm-timeline-months');
    if (yearHost) {
      yearHost.replaceChildren();
      const tous = document.createElement('button');
      tous.type = 'button';
      tous.className = `carnet-chip${selectedYear == null ? ' is-active' : ''}`;
      tous.textContent = 'Tous';
      tous.setAttribute('aria-pressed', selectedYear == null ? 'true' : 'false');
      tous.addEventListener('click', () => {
        selectedYear = null;
        selectedMonth = null;
        writeStoredPeriod();
        void load();
      });
      yearHost.appendChild(tous);
      years.forEach((year) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `carnet-chip${selectedYear === year ? ' is-active' : ''}`;
        btn.textContent = String(year);
        btn.setAttribute('aria-pressed', selectedYear === year ? 'true' : 'false');
        btn.addEventListener('click', () => {
          selectedYear = year;
          selectedMonth = null;
          writeStoredPeriod();
          void load();
        });
        yearHost.appendChild(btn);
      });
    }
    if (monthHost) {
      monthHost.replaceChildren();
      monthHost.hidden = selectedYear == null;
      if (selectedYear != null) {
        months.forEach((month) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `carnet-chip carnet-chip--month${selectedMonth === month ? ' is-active' : ''}`;
          btn.textContent = MONTH_LABELS[month - 1] || String(month);
          btn.setAttribute('aria-pressed', selectedMonth === month ? 'true' : 'false');
          btn.addEventListener('click', () => {
            selectedMonth = selectedMonth === month ? null : month;
            writeStoredPeriod();
            void load();
          });
          monthHost.appendChild(btn);
        });
      }
    }
  }

  function renderIndex(visible) {
    const rail = $('crm-index-rail');
    if (!rail) return;
    const present = new Set(visible.map((patient) => patient.letter));
    rail.replaceChildren();
    LETTERS.forEach((letter) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `carnet-index__letter${letterFilter === letter ? ' is-active' : ''}`;
      btn.textContent = letter;
      btn.disabled = !present.has(letter);
      btn.setAttribute('aria-label', `Lettre ${letter}`);
      if (present.has(letter)) {
        btn.addEventListener('click', () => {
          letterFilter = letterFilter === letter ? '' : letter;
          renderBook();
        });
      }
      rail.appendChild(btn);
    });
  }

  function renderBook() {
    const host = listHost();
    if (!host) return;
    host.replaceChildren();
    groupsById = {};
    const skeleton = $('crm-skeleton');
    const content = $('crm-content');
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = false;

    renderTimeline();

    if (!groups.length) {
      const copy = emptyCopy();
      setEmpty(true, copy.title, copy.message);
      renderIndex([]);
      return;
    }

    const visible = visibleGroups();
    renderIndex(groups);
    if (!visible.length) {
      setEmpty(true, 'Aucun patient sur cette lettre', 'Choisissez une autre lettre dans l’index.');
      return;
    }
    setEmpty(false);

    const fragment = document.createDocumentFragment();
    let currentLetter = '';
    visible.forEach((patient) => {
      const id = String(patient.id);
      groupsById[id] = patient;
      const sectionLetter = patient.last_starts_at ? patient.letter : 'Sans rendez-vous';
      if (sectionLetter !== currentLetter) {
        currentLetter = sectionLetter;
        const heading = document.createElement('li');
        heading.className = 'carnet-book__section';
        heading.textContent = sectionLetter;
        fragment.appendChild(heading);
      }

      const item = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'carnet-book__row crm-table-row';
      row.dataset.patientId = id;

      const name = document.createElement('span');
      name.className = 'carnet-book__name';
      name.textContent = patient.name || 'Non spécifié';

      const meta = document.createElement('span');
      meta.className = 'carnet-book__meta';
      const phone = patient.phone || 'Sans téléphone';
      const visit = patient.lastWhen || 'Sans rendez-vous';
      const soin = patient.motif || '';
      meta.textContent = soin ? `${phone} · ${visit} · ${soin}` : `${phone} · ${visit}`;

      row.append(name, meta);
      row.addEventListener('click', () => openSheet(patient));
      item.appendChild(row);
      fragment.appendChild(item);
    });
    host.appendChild(fragment);
    global.refreshLucideIcons?.($('view-crm') || document);
  }

  function initSheetSelect(key, ids, defaultValue) {
    const api = global.DentaFlowSelect?.init?.({
      root: $(ids.root),
      hidden: $(ids.hidden),
      trigger: $(ids.trigger),
      list: $(ids.list),
      label: $(ids.label),
      defaultValue,
    });
    if (api) sheetSelects[key] = api;
    return api;
  }

  function optionEl(value, label, selected) {
    const li = document.createElement('li');
    li.className = selected ? 'ghost-select__option is-selected' : 'ghost-select__option';
    li.setAttribute('role', 'option');
    li.dataset.value = value;
    li.dataset.label = label;
    li.setAttribute('aria-selected', selected ? 'true' : 'false');
    li.tabIndex = -1;
    li.textContent = label;
    return li;
  }

  function fillBeneficiaryOptions(patient) {
    const list = $('crm-edit-beneficiary-list');
    if (!list) return;
    const currentId = String(patient.patient_id || '');
    const selected = String(patient.beneficiary_of_patient_id || '');
    const fragment = document.createDocumentFragment();
    fragment.appendChild(optionEl('', '—', !selected));
    const seen = new Set(['']);
    groups.forEach((row) => {
      const id = String(row.patient_id || '');
      if (!id || id === currentId || seen.has(id)) return;
      seen.add(id);
      fragment.appendChild(optionEl(id, row.name || id, id === selected));
    });
    if (selected && !seen.has(selected)) {
      fragment.appendChild(optionEl(
        selected,
        patient.beneficiary_name || selected,
        true
      ));
    }
    list.replaceChildren(fragment);
    if (!sheetSelects.beneficiary) {
      initSheetSelect('beneficiary', {
        root: 'crm-edit-beneficiary-root',
        hidden: 'crm-edit-beneficiary',
        trigger: 'crm-edit-beneficiary-trigger',
        list: 'crm-edit-beneficiary-list',
        label: 'crm-edit-beneficiary-value',
      }, '');
    }
    sheetSelects.beneficiary?.refresh({ initialValue: selected });
  }

  function setField(id, value) {
    const el = $(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value == null ? '' : String(value);
  }

  function fieldValue(id) {
    const el = $(id);
    if (!el) return '';
    if (el.type === 'checkbox') return el.checked;
    return el.value;
  }

  function markSelected(patientId) {
    carnetRoot().querySelectorAll('.crm-table-row.is-selected, .carnet-book__row.is-selected').forEach((row) => {
      row.classList.remove('is-selected');
    });
    carnetRoot().querySelector(`.carnet-book__row[data-patient-id="${CSS.escape(String(patientId))}"]`)
      ?.classList.add('is-selected');
  }

  function renderVisits(visits) {
    const host = $('crm-panel-visits');
    if (!host) return;
    host.replaceChildren();
    const rows = Array.isArray(visits) ? visits : [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'chair-glance__empty';
      empty.textContent = 'Aucune visite enregistrée.';
      host.appendChild(empty);
      return;
    }
    rows.slice(0, 12).forEach((visit) => {
      const row = document.createElement('div');
      row.className = 'carnet-visit';
      const left = document.createElement('span');
      left.textContent = `${formatWhen(visit)} · ${visit.treatment || visit.treatment_name || 'Soin'}`;
      const right = document.createElement('span');
      right.textContent = visit.status || '';
      row.append(left, right);
      host.appendChild(row);
    });
  }

  async function loadVisits(patient) {
    if (!UUID_RE.test(String(patient.patient_id || ''))) {
      patient.visits = [];
      renderVisits([]);
      return;
    }
    renderVisits([]);
    try {
      const response = await fetch(`${ROSTER_URL}?patient_id=${encodeURIComponent(patient.patient_id)}`, {
        method: 'GET',
        credentials: 'include',
        headers: authHeaders({ Accept: 'application/json' }),
        cache: 'no-store',
      });
      assertAuthorized(response);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      patient.visits = rows;
      renderVisits(rows);
    } catch {
      renderVisits([]);
    }
  }

  function openSheet(patient) {
    const root = $('crm-side-panel');
    if (!root || !patient) return;
    markSelected(patient.id);

    if ($('crm-panel-name')) $('crm-panel-name').textContent = patient.name || 'Dossier';
    if ($('crm-panel-subtitle')) {
      const last = patient.lastWhen || formatDay(patient.last_starts_at) || 'Sans rendez-vous';
      $('crm-panel-subtitle').textContent = patient.phone
        ? `${patient.phone} · ${last}`
        : last;
    }
    const statusEl = $('crm-panel-status') || $('crm-panel-statut');
    if (statusEl) statusEl.textContent = patient.statut || '';

    setField('crm-edit-name', patient.name);
    setField('crm-edit-phone', patient.phone);
    setField('crm-edit-email', patient.email);
    setField('crm-edit-allergies', patient.allergies);
    setField('crm-edit-chronic', patient.chronic_conditions);
    setField('crm-edit-anesthetic', patient.preferred_anesthetic);
    setField('crm-edit-xray', patient.last_xray_on ? String(patient.last_xray_on).slice(0, 10) : '');
    setField('crm-edit-notes', patient.clinical_notes);
    setField('crm-edit-sms', patient.sms_consent === true);
    setField('crm-edit-member', patient.insurance_member_number);
    setField('crm-edit-mutuelle', patient.mutuelle_name);
    sheetSelects.insurance?.setValue(patient.insurance_type || '');
    sheetSelects.relation?.setValue(patient.beneficiary_relation || '');
    fillBeneficiaryOptions(patient);
    if ($('crm-panel-copay')) {
      $('crm-panel-copay').textContent = madLabel(patient.honoraires_saisis, patient.honoraires_rows);
    }
    if ($('crm-edit-id')) $('crm-edit-id').value = patient.patient_id || '';

    const saveBtn = $('crm-edit-save');
    if (saveBtn) saveBtn.disabled = !UUID_RE.test(String(patient.patient_id || ''));

    root.classList.add('is-active');
    root.setAttribute('aria-hidden', 'false');
    $('crm-side-panel-close')?.focus();
    void loadVisits(patient);
  }

  function closeSheet() {
    const root = $('crm-side-panel');
    if (!root) return;
    root.classList.remove('is-active');
    root.setAttribute('aria-hidden', 'true');
    carnetRoot().querySelectorAll('.crm-table-row.is-selected, .carnet-book__row.is-selected').forEach((row) => {
      row.classList.remove('is-selected');
    });
  }

  async function saveSheet() {
    const patientId = fieldValue('crm-edit-id');
    const saveBtn = $('crm-edit-save');
    if (!UUID_RE.test(String(patientId))) {
      global.showToast?.('Ce dossier n\'a pas encore d\'identité patient. Posez un rendez-vous pour le lier.', 'warning');
      return;
    }
    if (saveBtn) saveBtn.disabled = true;
    try {
      const response = await fetch(`${ROSTER_URL}?action=patient`, {
        method: 'PATCH',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          id: patientId,
          name: fieldValue('crm-edit-name'),
          phone: fieldValue('crm-edit-phone'),
          email: fieldValue('crm-edit-email'),
          allergies: fieldValue('crm-edit-allergies'),
          chronic_conditions: fieldValue('crm-edit-chronic'),
          preferred_anesthetic: fieldValue('crm-edit-anesthetic'),
          last_xray_on: fieldValue('crm-edit-xray') || null,
          notes: fieldValue('crm-edit-notes'),
          smsConsent: Boolean(fieldValue('crm-edit-sms')),
          insurance_type: fieldValue('crm-edit-insurance') || null,
          insurance_member_number: fieldValue('crm-edit-member'),
          mutuelle_name: fieldValue('crm-edit-mutuelle'),
          beneficiary_of_patient_id: fieldValue('crm-edit-beneficiary') || null,
          beneficiary_relation: fieldValue('crm-edit-relation') || null,
        }),
      });
      assertAuthorized(response);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      global.showToast?.('Dossier enregistré.', 'success');
      await load($('crm-search')?.value.trim() || '');
      const updated = groups.find((group) => String(group.patient_id) === String(patientId));
      if (updated) openSheet(updated);
    } catch (err) {
      global.showToast?.(err?.message || 'Impossible d\'enregistrer le dossier.', 'error');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function directoryUrl(query) {
    const params = new URLSearchParams({ directory: '1' });
    const q = String(query || '').trim();
    if (q) params.set('q', q);
    else {
      if (selectedYear != null) params.set('year', String(selectedYear));
      if (selectedMonth != null) params.set('month', String(selectedMonth));
    }
    return `${ROSTER_URL}?${params.toString()}`;
  }

  async function load(query) {
    const host = listHost();
    if (!host) return;
    const q = query != null ? String(query).trim() : ($('crm-search')?.value.trim() || '');
    try {
      const response = await fetch(directoryUrl(q), {
        method: 'GET',
        credentials: 'include',
        headers: authHeaders({ Accept: 'application/json' }),
        cache: 'no-store',
      });
      assertAuthorized(response);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      const bundle = payload?.data && !Array.isArray(payload.data) ? payload.data : {};
      const rows = Array.isArray(bundle.patients)
        ? bundle.patients
        : (Array.isArray(payload?.data) ? payload.data : []);
      years = Array.isArray(bundle.years) ? bundle.years : [];
      months = Array.isArray(bundle.months) ? bundle.months : [];
      if (selectedYear != null && !years.includes(selectedYear)) {
        selectedYear = null;
        selectedMonth = null;
        writeStoredPeriod();
      }
      if (selectedMonth != null && !months.includes(selectedMonth)) {
        selectedMonth = null;
        writeStoredPeriod();
      }
      groups = rows.map(mapPatient).slice().sort((a, b) => {
        const aKey = a.last_starts_at ? `0${a.letter}${a.name}` : `1${a.name}`;
        const bKey = b.last_starts_at ? `0${b.letter}${b.name}` : `1${b.name}`;
        return aKey.localeCompare(bKey, 'fr', { sensitivity: 'base' });
      });
      renderBook();
    } catch (err) {
      groups = [];
      years = [];
      months = [];
      renderBook();
      setEmpty(true, 'Dossiers indisponibles', err?.message || 'Réessayez dans un instant.');
    }
  }

  function bind() {
    const root = carnetRoot();
    if (boundRoots.has(root)) return;
    const searchEl = $('crm-search');
    const host = listHost();
    if (!searchEl || !host) return;
    boundRoots.add(root);
    readStoredPeriod();

    initSheetSelect('insurance', {
      root: 'crm-edit-insurance-root',
      hidden: 'crm-edit-insurance',
      trigger: 'crm-edit-insurance-trigger',
      list: 'crm-edit-insurance-list',
      label: 'crm-edit-insurance-value',
    }, '');
    initSheetSelect('relation', {
      root: 'crm-edit-relation-root',
      hidden: 'crm-edit-relation',
      trigger: 'crm-edit-relation-trigger',
      list: 'crm-edit-relation-list',
      label: 'crm-edit-relation-value',
    }, '');
    initSheetSelect('beneficiary', {
      root: 'crm-edit-beneficiary-root',
      hidden: 'crm-edit-beneficiary',
      trigger: 'crm-edit-beneficiary-trigger',
      list: 'crm-edit-beneficiary-list',
      label: 'crm-edit-beneficiary-value',
    }, '');

    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        letterFilter = '';
        void load(searchEl.value.trim());
      }, 280);
    });

    $('crm-side-panel-close')?.addEventListener('click', closeSheet);
    $('crm-side-panel-overlay')?.addEventListener('click', closeSheet);
    $('crm-edit-save')?.addEventListener('click', (event) => {
      event.preventDefault();
      void saveSheet();
    });
    $('crm-edit-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveSheet();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('crm-side-panel')?.classList.contains('is-active')) {
        closeSheet();
      }
    });
  }

  function init() {
    bind();
    void load($('crm-search')?.value.trim() || '');
  }

  global.DentaFlowCarnet = {
    init,
    load,
    openSheet,
    closeSheet,
  };
})(window);
