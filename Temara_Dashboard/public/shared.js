/**
 * DentaFlow OS — shared client helpers.
 * Wires the settings password form to POST /api/auth/password (PostgreSQL + scrypt).
 */
(function () {
  'use strict';

  const PASSWORD_ENDPOINT = '/api/auth/password';
  const MIN_PASSWORD_LENGTH = 8;

  function showPasswordToast(message, type) {
    const toast = document.getElementById('assistant-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('is-error', 'is-success', 'is-warning');
    if (type === 'error') toast.classList.add('is-error');
    if (type === 'success') toast.classList.add('is-success');
    if (type === 'warning') toast.classList.add('is-warning');
    toast.classList.add('is-visible');
    window.clearTimeout(showPasswordToast._timer);
    showPasswordToast._timer = window.setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 3200);
  }

  function ensureCurrentPasswordField(form) {
    if (form.querySelector('#security-password-current, [name="currentPassword"]')) return;
    const newField = form.querySelector('#security-password-new')?.closest('.settings-field');
    const wrap = document.createElement('div');
    wrap.className = 'settings-field';
    wrap.innerHTML = [
      '<label class="settings-label" for="security-password-current">Mot de passe actuel</label>',
      '<input type="password" class="waitlist-input settings-input" id="security-password-current"',
      ' name="currentPassword" autocomplete="current-password" required aria-required="true" />',
    ].join('');
    if (newField) form.insertBefore(wrap, newField);
    else form.insertBefore(wrap, form.firstElementChild);
  }

  function ensureAssistantPasswordForm(scope) {
    const root = scope || document;
    if (root.querySelector('#security-access-form, #assistant-security-access-form')) return;
    const grid = root.querySelector('#view-settings .settings-grid');
    if (!grid) return;

    const article = document.createElement('article');
    article.className = 'settings-card settings-card--security';
    article.innerHTML = [
      '<div class="settings-card-icon" aria-hidden="true"><i data-lucide="lock" aria-hidden="true"></i></div>',
      '<h3 class="settings-card-title">Sécurité</h3>',
      '<p class="settings-card-desc">Mettre à jour le mot de passe du compte actuellement connecté.</p>',
      '<form id="assistant-security-access-form" class="security-form" data-password-change="true" novalidate>',
      '  <div class="settings-field">',
      '    <label class="settings-label" for="assistant-security-password-current">Mot de passe actuel</label>',
      '    <input type="password" class="waitlist-input settings-input" id="assistant-security-password-current"',
      '      name="currentPassword" autocomplete="current-password" required aria-required="true" />',
      '  </div>',
      '  <div class="settings-field">',
      '    <label class="settings-label" for="assistant-security-password-new">Nouveau mot de passe</label>',
      '    <input type="password" class="waitlist-input settings-input" id="assistant-security-password-new"',
      '      name="password-new" autocomplete="new-password" required aria-required="true" minlength="8" />',
      '  </div>',
      '  <div class="settings-field">',
      '    <label class="settings-label" for="assistant-security-password-confirm">Confirmer le mot de passe</label>',
      '    <input type="password" class="waitlist-input settings-input" id="assistant-security-password-confirm"',
      '      name="password-confirm" autocomplete="new-password" required aria-required="true" minlength="8" />',
      '  </div>',
      '  <button type="submit" class="security-form__submit btn-matte-primary" id="assistant-security-submit-btn">',
      "    Mettre à jour l'accès",
      '  </button>',
      '</form>',
    ].join('');
    grid.appendChild(article);
    window.refreshLucideIcons?.(article);
  }

  async function changePassword(currentPassword, newPassword) {
    const response = await fetch(PASSWORD_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { response, payload };
  }

  function readField(form, selectors) {
    for (const selector of selectors) {
      const el = form.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function bindOneForm(form) {
    if (!form || form.dataset.passwordApiBound === 'true') return;
    form.dataset.passwordApiBound = 'true';
    ensureCurrentPasswordField(form);

    form.addEventListener(
      'submit',
      async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();

        const currentInput = readField(form, [
          '#security-password-current',
          '#assistant-security-password-current',
          '[name="currentPassword"]',
          '[autocomplete="current-password"]',
        ]);
        const newInput = readField(form, [
          '#security-password-new',
          '#assistant-security-password-new',
          '[name="password-new"]',
          '[autocomplete="new-password"]',
        ]);
        const confirmInput = readField(form, [
          '#security-password-confirm',
          '#assistant-security-password-confirm',
          '[name="password-confirm"]',
        ]);
        const submitBtn = form.querySelector('[type="submit"]');

        const currentPassword = currentInput?.value ?? '';
        const newPassword = newInput?.value ?? '';
        const confirmPassword = confirmInput?.value ?? '';

        if (!currentPassword) {
          showPasswordToast('Veuillez renseigner le mot de passe actuel.', 'warning');
          currentInput?.focus();
          return;
        }
        if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
          showPasswordToast('Le nouveau mot de passe doit contenir au moins 8 caractères.', 'warning');
          newInput?.focus();
          return;
        }
        if (confirmInput && newPassword !== confirmPassword) {
          showPasswordToast('Les mots de passe ne correspondent pas.', 'error');
          confirmInput.focus();
          return;
        }

        if (submitBtn) submitBtn.disabled = true;
        try {
          const { response, payload } = await changePassword(currentPassword, newPassword);
          if (response.ok && payload?.ok) {
            if (currentInput) currentInput.value = '';
            if (newInput) newInput.value = '';
            if (confirmInput) confirmInput.value = '';
            showPasswordToast(payload.message || 'Mot de passe mis à jour avec succès', 'success');
            return;
          }
          const message =
            payload?.error || payload?.message || 'Impossible de mettre à jour le mot de passe.';
          showPasswordToast(message, 'error');
        } catch {
          showPasswordToast('Impossible de mettre à jour le mot de passe — réessayez.', 'error');
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      },
      true
    );
  }

  function bindPasswordForm(root) {
    const scope = root || document;
    ensureAssistantPasswordForm(scope);
    const forms = scope.querySelectorAll(
      '#security-access-form, #assistant-security-access-form, form[data-password-change="true"]'
    );
    forms.forEach(bindOneForm);
  }

  window.DentaFlowAuth = window.DentaFlowAuth || {};
  window.DentaFlowAuth.bindPasswordForm = bindPasswordForm;
  window.DentaFlowAuth.changePassword = changePassword;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bindPasswordForm());
  } else {
    bindPasswordForm();
  }
})();
