/**
 * Shared roster / waitlist row factories (chips, avatars, empty states).
 * Action menus are attached later by the assistant shell via createRowActionGroup.
 */
(function () {
  'use strict';

  const RowUI = {};

  function lucideIcon(name, className) {
    return window.lucideIcon?.(name, className)
      ?? `<i data-lucide="${name}"${className ? ` class="${className}"` : ''} aria-hidden="true"></i>`;
  }

  const NOSHOW_SVG = lucideIcon('alert-triangle', 'icon-sm');
  const EMPTY_STATE_SVG_CALENDAR = lucideIcon('calendar-clock', 'icon-lg');
  const EMPTY_STATE_SVG_INBOX = lucideIcon('inbox', 'icon-lg');
  const EMPTY_STATE_DEFAULT_MESSAGE = 'Aucun rendez-vous pour le moment.';

  function extractInitials(fullName) {
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

  function createStatusDot(label) {
    const dot = document.createElement('span');
    dot.className = `status-dot status-dot--${getMatteChipModifier(label)}`;
    dot.title = label;
    dot.setAttribute('aria-label', label);
    return dot;
  }

  function createPriorityIndicator(label) {
    const wrap = document.createElement('span');
    wrap.className = 'status-indicator';
    wrap.appendChild(createStatusDot(label));
    const text = document.createElement('span');
    text.className = 'status-indicator__label kinetic-label';
    text.textContent = label;
    wrap.appendChild(text);
    return wrap;
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
    const { showNoShow = false, hasNotes = false, isNewPatient = false } = options;
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
      window.refreshLucideIcons?.(flagSpan);
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

    if (isNewPatient) {
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
      labelWrap.appendChild(badge);
    }

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

  function getWaitlistPriorityLabel(appt) {
    if (appt.statusLabel) return appt.statusLabel;
    const treatment = String(appt.treatment ?? appt.priorite ?? '').toLowerCase();
    if (appt.tagClass === 'urgence' || treatment === 'haute' || treatment === 'urgent') return 'Urgence';
    return 'En attente';
  }

  function isWaitlistUrgent(appt) {
    if (appt.priority === 1) return true;
    if (appt.tagClass === 'urgence') return true;
    const treatment = String(appt.treatment ?? appt.priorite ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    return treatment === 'haute' || treatment === 'urgent' || treatment.includes('urgence');
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

  function createWaitlistTableRow(appt) {
    const tr = document.createElement('tr');
    tr.className = 'waitlist-row';
    tr.dataset.rowInteractive = 'true';
    tr.dataset.priority = String(appt.priority ?? (isWaitlistUrgent(appt) ? 1 : 2));
    if (isWaitlistUrgent(appt)) tr.dataset.urgent = 'true';

    const patientTd = document.createElement('td');
    const rowInner = document.createElement('div');
    rowInner.className = 'waitlist-row__inner';

    const main = document.createElement('div');
    main.className = 'waitlist-row__main';
    main.appendChild(createPatientIdentity(appt.name));

    rowInner.append(main);
    if (typeof RowUI.createRowActionGroup === 'function') {
      rowInner.append(RowUI.createRowActionGroup({
        kind: 'waitlist',
        appt,
        phone: appt.phone || appt.telephone,
        priorite: appt.priorite || appt.treatment,
      }));
    }
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
    priorityTd.appendChild(createPriorityIndicator(getWaitlistPriorityLabel(appt)));

    tr.append(patientTd, phoneTd, priorityTd);
    return tr;
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
    window.refreshLucideIcons?.(icon);

    const text = document.createElement('p');
    text.className = 'empty-state__text';
    text.textContent = message;

    wrap.append(icon, text);
    return wrap;
  }

  function mountEmptyState(hostId, options = {}) {
    const host = document.getElementById(hostId);
    if (!host) return null;
    host.replaceChildren();
    const state = createEmptyState(options);
    host.appendChild(state);
    host.hidden = false;
    initEmptyStatePulse(state);
    return state;
  }

  function clearEmptyState(hostId) {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.replaceChildren();
    host.hidden = true;
  }

  function initEmptyStatePulse(emptyStateEl) {
    const icon = emptyStateEl?.querySelector('.empty-state__icon');
    if (icon) icon.style.opacity = '0.4';
  }

  Object.assign(RowUI, {
    extractInitials,
    getMatteChipModifier,
    createStatusDot,
    createPriorityIndicator,
    createMatteChip,
    createPatientAvatar,
    createPatientIdentity,
    getWaitlistPriorityLabel,
    isWaitlistUrgent,
    createCopyableSpan,
    createWaitlistTableRow,
    createEmptyState,
    mountEmptyState,
    clearEmptyState,
    initEmptyStatePulse,
    EMPTY_STATE_DEFAULT_MESSAGE,
    EMPTY_STATE_SVG_INBOX,
    EMPTY_STATE_SVG_CALENDAR,
  });

  window.DentaFlowRowUI = RowUI;
})();
