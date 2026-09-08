/**
 * Shared Dossiers Patients (carnet) — doctor + assistant.
 * 90-day directory, iOS detail sheet, PATCH /api/roster?action=patient.
 */
(function (global) {
  'use strict';

  const ROSTER_URL = '/api/roster';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  let groups = [];
  let groupsById = {};
  let searchTimer = null;
  const boundRoots = new WeakSet();

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
      const scoped = root.querySelector('[id="' + String(id).replace(/"/g, '\\"') + '"]');
      if (scoped) return scoped;
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
    const raw = row?.starts_at || row?.rawDate || row?.startTime;
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

  function madLabel(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return `${Math.round(n)} MAD`;
  }

  function groupBookings(rows) {
    const map = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (String(row.booking_kind || row.bookingKind || 'visit') !== 'visit') return;
      const phone = String(row.phone || row.patient_phone || '').trim();
      const name = String(row.name || row.patient_name || row.patient_display_name || '').trim();
      const patientId = row.patient_id || row.patientId || '';
      const key = String(patientId || phone || name.toLowerCase());
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, {
          id: patientId || key,
          patient_id: patientId || null,
          name: name || 'Non spécifié',
          phone,
          email: row.email || row.patient_email || '',
          allergies: row.allergies || '',
          chronic_conditions: row.chronic_conditions || '',
          preferred_anesthetic: row.preferred_anesthetic || '',
          last_xray_on: row.last_xray_on || '',
          clinical_notes: row.clinical_notes || row.notes || '',
          sms_consent: row.sms_consent !== false,
          insurance: row.insurance || row.insurance_type || '',
          copay_mad: row.copay_mad,
          visits: [],
        });
      }
      const group = map.get(key);
      if (name && group.name === 'Non spécifié') group.name = name;
      if (phone && !group.phone) group.phone = phone;
      if (patientId) group.patient_id = patientId;
      if (row.email || row.patient_email) group.email = row.email || row.patient_email;
      if (row.allergies) group.allergies = row.allergies;
      if (row.chronic_conditions) group.chronic_conditions = row.chronic_conditions;
      if (row.preferred_anesthetic) group.preferred_anesthetic = row.preferred_anesthetic;
      if (row.last_xray_on) group.last_xray_on = row.last_xray_on;
      if (row.clinical_notes) group.clinical_notes = row.clinical_notes;
      if (typeof row.sms_consent === 'boolean') group.sms_consent = row.sms_consent;
      group.visits.push(row);
    });
    return [...map.values()].map((group) => {
      group.visits.sort((a, b) => String(b.starts_at || '').localeCompare(String(a.starts_at || '')));
      group.lastVisit = group.visits[0] || null;
      group.motif = group.lastVisit?.treatment || group.lastVisit?.treatment_name || 'Consultation';
      group.statut = group.lastVisit?.status || 'Non renseigné';
      group.lastWhen = formatWhen(group.lastVisit || {});
      const fromApi = Number(group.lastVisit?.noshow_90d);
      group.noshow90 = Number.isFinite(fromApi)
        ? fromApi
        : group.visits.filter((visit) => /no-?show/i.test(String(visit.status || ''))).length;
      group.solde = group.visits.reduce((sum, visit) => {
        const copay = Number(visit.copay_mad);
        const unpaid = /no-?show|annul|attente/i.test(String(visit.status || '')) ? 0 : copay;
        return sum + (Number.isFinite(unpaid) ? unpaid : 0);
      }, 0);
      return group;
    });
  }

  function setEmpty(visible, title, message) {
    const host = $('crm-empty-state');
    const scroll = document.querySelector('#view-crm .crm-table-scroll');
    if (host) {
      host.hidden = !visible;
      const t = host.querySelector('.ios-empty__title');
      const m = host.querySelector('.ios-empty__text');
      if (t && title) t.textContent = title;
      if (m && message) m.textContent = message;
    }
    if (scroll) scroll.hidden = Boolean(visible);
  }

  function renderTable() {
    const tbody = $('crm-table-body');
    if (!tbody) return;
    tbody.replaceChildren();
    groupsById = {};
    const skeleton = $('crm-skeleton');
    const content = $('crm-content');
    if (skeleton) skeleton.hidden = true;
    if (content) content.hidden = false;

    if (!groups.length) {
      setEmpty(true, 'Aucun dossier à afficher', 'Recherchez un nom ou un téléphone sur les 90 derniers jours.');
      return;
    }
    setEmpty(false);

    const fragment = document.createDocumentFragment();
    groups.forEach((patient) => {
      const id = String(patient.id);
      groupsById[id] = patient;
      const tr = document.createElement('tr');
      tr.className = 'crm-table-row';
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.dataset.patientId = id;

      const nameCell = document.createElement('td');
      nameCell.textContent = patient.name || 'Non spécifié';

      const phoneCell = document.createElement('td');
      phoneCell.textContent = patient.phone || 'Non renseigné';

      const lastCell = document.createElement('td');
      lastCell.textContent = patient.lastWhen || '—';

      const motifCell = document.createElement('td');
      motifCell.textContent = patient.motif || '—';

      const soldeCell = document.createElement('td');
      soldeCell.textContent = madLabel(patient.solde);

      const noshowCell = document.createElement('td');
      noshowCell.textContent = `${patient.noshow90 || 0} (90 j)`;

      tr.append(nameCell, phoneCell, lastCell, motifCell, soldeCell, noshowCell);
      tr.addEventListener('click', () => openSheet(patient));
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openSheet(patient);
        }
      });
      fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
    global.refreshLucideIcons?.($('view-crm') || document);
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

  function openSheet(patient) {
    const root = $('crm-side-panel');
    if (!root || !patient) return;
    document.querySelectorAll('.crm-table-row.is-selected').forEach((row) => {
      row.classList.remove('is-selected');
    });
    document.querySelector(`.crm-table-row[data-patient-id="${CSS.escape(String(patient.id))}"]`)
      ?.classList.add('is-selected');

    if ($('crm-panel-name')) $('crm-panel-name').textContent = patient.name || 'Dossier';
    if ($('crm-panel-subtitle')) {
      $('crm-panel-subtitle').textContent = patient.phone
        ? `${patient.phone} · ${patient.lastWhen || 'Sans visite récente'}`
        : (patient.lastWhen || 'Sans visite récente');
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
    setField('crm-edit-sms', patient.sms_consent !== false);
    if ($('crm-panel-copay')) $('crm-panel-copay').textContent = madLabel(patient.lastVisit?.copay_mad);
    if ($('crm-edit-id')) $('crm-edit-id').value = patient.patient_id || '';

    const visits = $('crm-panel-visits');
    if (visits) {
      visits.replaceChildren();
      (patient.visits || []).slice(0, 8).forEach((visit) => {
        const row = document.createElement('div');
        row.className = 'carnet-visit';
        const left = document.createElement('span');
        left.textContent = `${formatWhen(visit)} · ${visit.treatment || visit.treatment_name || 'Soin'}`;
        const right = document.createElement('span');
        right.textContent = visit.status || '';
        row.append(left, right);
        visits.appendChild(row);
      });
      if (!patient.visits?.length) {
        const empty = document.createElement('p');
        empty.className = 'chair-glance__empty';
        empty.textContent = 'Aucune visite récente.';
        visits.appendChild(empty);
      }
    }

    const saveBtn = $('crm-edit-save');
    if (saveBtn) saveBtn.disabled = !UUID_RE.test(String(patient.patient_id || ''));

    root.classList.add('is-active');
    root.setAttribute('aria-hidden', 'false');
    $('crm-side-panel-close')?.focus();
  }

  function closeSheet() {
    const root = $('crm-side-panel');
    if (!root) return;
    root.classList.remove('is-active');
    root.setAttribute('aria-hidden', 'true');
    document.querySelectorAll('.crm-table-row.is-selected').forEach((row) => {
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

  async function load(query) {
    const tbody = $('crm-table-body');
    if (!tbody) return;
    const q = String(query || '').trim();
    const url = q
      ? `${ROSTER_URL}?directory=1&q=${encodeURIComponent(q)}`
      : `${ROSTER_URL}?directory=1`;
    try {
      const response = await fetch(url, {
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
      groups = groupBookings(rows);
      renderTable();
    } catch (err) {
      groups = [];
      renderTable();
      setEmpty(true, 'Dossiers indisponibles', err?.message || 'Réessayez dans un instant.');
    }
  }

  function bind() {
    const root = carnetRoot();
    if (boundRoots.has(root)) return;
    const searchEl = $('crm-search');
    const tbody = $('crm-table-body');
    if (!searchEl || !tbody) return;
    boundRoots.add(root);

    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
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
