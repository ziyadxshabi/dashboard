/**
 * DentaFlow OS — centralized username/password authentication gate.
 * Dispatches to POST /api/auth; unlocks Doctor or Assistant modules on success.
 */
(function () {
  'use strict';

  const AUTH_ENDPOINT = '/api/auth';
  const SESSION_ROLE_KEY = 'dentaflow_role';
  const SESSION_TOKEN_KEY = 'dentaflow_session';

  let selectedRole = 'doctor';
  let authInitialized = false;
  let isSubmitting = false;

  function initLoginReveal() {
    const card = document.getElementById('login-card');
    if (!card) return;
    requestAnimationFrame(() => {
      card.classList.add('login-assembled');
    });
  }

  function getLoginErrorEl() {
    return document.getElementById('login-error');
  }

  function showLoginError(message) {
    const errorEl = getLoginErrorEl();
    const form = document.getElementById('login-form');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
    form?.classList.add('is-error');
    setTimeout(() => form?.classList.remove('is-error'), 650);
  }

  function clearLoginError() {
    const errorEl = getLoginErrorEl();
    const form = document.getElementById('login-form');
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
    form?.classList.remove('is-error');
  }

  function setSubmitLoading(loading) {
    const submitBtn = document.getElementById('login-submit');
    if (!submitBtn) return;
    submitBtn.disabled = loading;
    submitBtn.classList.toggle('is-loading', loading);
    submitBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
  }

  function setupRoleSelector() {
    const doctorBtn = document.getElementById('role-btn-doctor');
    const assistantBtn = document.getElementById('role-btn-assistant');
    const assistantOnly = document.body.dataset.authMode === 'assistant-only';

    if (!doctorBtn && !assistantBtn) return;

    function setRole(role) {
      selectedRole = role;
      doctorBtn?.classList.toggle('is-active', role === 'doctor');
      assistantBtn?.classList.toggle('is-active', role === 'assistant');
      doctorBtn?.setAttribute('aria-pressed', role === 'doctor' ? 'true' : 'false');
      assistantBtn?.setAttribute('aria-pressed', role === 'assistant' ? 'true' : 'false');
    }

    doctorBtn?.addEventListener('click', () => setRole('doctor'));
    assistantBtn?.addEventListener('click', () => setRole('assistant'));

    if (assistantOnly) {
      setRole('assistant');
      if (doctorBtn) doctorBtn.hidden = true;
      return;
    }

    setRole('doctor');
  }

  function setupPasswordToggle() {
    const toggle = document.getElementById('login-password-toggle');
    const passwordInput = document.getElementById('login-password');
    if (!toggle || !passwordInput) return;

    toggle.addEventListener('click', () => {
      const isHidden = passwordInput.type === 'password';
      passwordInput.type = isHidden ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
      toggle.setAttribute('aria-label', isHidden ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    });
  }

  function setupLoginForm() {
    const form = document.getElementById('login-form');
    if (!form || form.dataset.bound === 'true') return;
    form.dataset.bound = 'true';

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitAuth();
    });
  }

  async function submitAuth() {
    if (isSubmitting) return;

    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const username = usernameInput?.value?.trim() ?? '';
    const password = passwordInput?.value ?? '';

    clearLoginError();

    if (!username || !password) {
      showLoginError('Identifiant et mot de passe requis.');
      return;
    }

    isSubmitting = true;
    setSubmitLoading(true);

    try {
      const response = await fetch(AUTH_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          role: selectedRole,
          username,
          password,
        }),
      });

      if (response.status === 429) {
        let retryMessage = 'Trop de tentatives. Réessayez plus tard.';
        try {
          const payload = await response.json();
          if (payload?.retryAfterSec) {
            retryMessage = `Compte temporairement verrouillé. Réessayez dans ${payload.retryAfterSec}s.`;
          } else if (payload?.message) {
            retryMessage = payload.message;
          }
        } catch { /* keep default */ }
        showLoginError(retryMessage);
        return;
      }

      if (response.status === 401 || response.status === 403) {
        showLoginError('Identifiants incorrects.');
        return;
      }

      if (!response.ok) {
        showLoginError('Connexion impossible. Réessayez.');
        return;
      }

      const payload = await response.json();
      if (!payload?.ok || !payload?.token) {
        showLoginError('Identifiants incorrects.');
        return;
      }

      sessionStorage.setItem(SESSION_ROLE_KEY, payload.role || selectedRole);
      sessionStorage.setItem(SESSION_TOKEN_KEY, payload.token);

      if (passwordInput) passwordInput.value = '';

      await handleAuthSuccess(payload.role || selectedRole);
    } catch {
      showLoginError('Connexion impossible. Vérifiez le réseau.');
    } finally {
      isSubmitting = false;
      setSubmitLoading(false);
    }
  }

  function dismissLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    overlay.classList.add('is-unlocking');
    setTimeout(() => overlay.remove(), 400);
  }

  function showShell(el) {
    if (!el) return;
    el.hidden = false;
    el.style.display = '';
  }

  function hideShell(el) {
    if (!el) return;
    el.hidden = true;
    el.style.display = 'none';
  }

  function clearAuthBootClasses() {
    document.body.classList.remove('os-boot-pending');
  }

  function triggerRoleBootSequence(role) {
    if (role === 'assistant') {
      if (typeof window.queueAssistantOsBootSequence === 'function') {
        window.queueAssistantOsBootSequence();
      } else if (typeof window.revealAssistantOsBootFallback === 'function') {
        window.revealAssistantOsBootFallback();
      }
      return;
    }

    if (typeof window.queueDoctorOsBootSequence === 'function') {
      window.queueDoctorOsBootSequence();
    } else if (typeof window.revealDoctorOsBootFallback === 'function') {
      window.revealDoctorOsBootFallback();
    }
  }

  function isolateDoctorShell() {
    const assistantShell = document.getElementById('assistant-shell');
    const assistantMount = document.getElementById('assistant-mount');

    assistantMount?.replaceChildren();
    hideShell(assistantShell);
    hideShell(assistantMount);

    showShell(document.getElementById('doctor-shell'));
  }

  async function isolateAssistantShell() {
    const doctorShell = document.getElementById('doctor-shell');
    if (doctorShell) {
      hideShell(doctorShell);
      doctorShell.remove();
    }

    const assistantShell = document.getElementById('assistant-shell');
    const mount = document.getElementById('assistant-mount');

    if (mount && !mount.childElementCount) {
      const response = await fetch('/assistant-shell.html', { cache: 'no-store' });
      if (!response.ok) throw new Error('Assistant shell unavailable');
      const html = await response.text();
      const template = document.createElement('template');
      template.innerHTML = html;
      mount.replaceChildren(...template.content.childNodes);
    }

    showShell(assistantShell);
    showShell(mount);
  }

  async function unlockDoctorModule() {
    document.body.classList.add('mode-doctor');
    document.body.classList.remove('mode-assistant');
    isolateDoctorShell();

    if (typeof window.initializeDoctorDashboard === 'function') {
      window.initializeDoctorDashboard();
    }
    if (typeof window.unlockDashboard === 'function') {
      window.unlockDashboard();
    }
  }

  async function unlockAssistantModule() {
    document.body.classList.add('mode-assistant');
    document.body.classList.remove('mode-doctor');
    await isolateAssistantShell();

    if (typeof window.initializeAssistantDashboard === 'function') {
      window.initializeAssistantDashboard();
    }
  }

  async function handleAuthSuccess(role) {
    document.body.classList.remove('auth-gate-active');
    dismissLoginOverlay();

    if (role === 'assistant') {
      await unlockAssistantModule();
    } else {
      await unlockDoctorModule();
    }

    clearAuthBootClasses();
    triggerRoleBootSequence(role);
  }

  function tryRestoreSession() {
    const role = sessionStorage.getItem(SESSION_ROLE_KEY);
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);

    if (!role || !token) {
      initLoginReveal();
      setupRoleSelector();
      setupPasswordToggle();
      setupLoginForm();
      return;
    }

    handleAuthSuccess(role);
  }

  function initAuthGate() {
    if (authInitialized) return;
    authInitialized = true;

    if (document.body.classList.contains('mode-client')) return;
    if (!document.body.classList.contains('auth-gate-active')) return;

    tryRestoreSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuthGate);
  } else {
    initAuthGate();
  }

  function getBearerToken() {
    return sessionStorage.getItem(SESSION_TOKEN_KEY) || '';
  }

  function buildAuthHeaders(extra = {}) {
    const headers = {
      Accept: 'application/json',
      ...extra,
    };
    const token = getBearerToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  window.DentaFlowAuth = {
    SESSION_ROLE_KEY,
    SESSION_TOKEN_KEY,
    getRole: () => sessionStorage.getItem(SESSION_ROLE_KEY),
    getToken: getBearerToken,
    getAuthHeaders: buildAuthHeaders,
    clearSession() {
      sessionStorage.removeItem(SESSION_ROLE_KEY);
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
    },
  };
})();
