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
  let isLoggingOut = false;
  const logoutTeardowns = [];

  function initLoginReveal() {
    const overlay = document.getElementById('login-overlay');
    const card = document.getElementById('login-card');
    if (!overlay || !card) return;
    requestAnimationFrame(() => {
      overlay.classList.add('login-assembled');
      card.classList.add('login-assembled');
      window.refreshLucideIcons?.(overlay);
    });
  }

  function getLoginErrorEl() {
    return document.getElementById('login-error');
  }

  function showLoginError(message) {
    const errorEl = getLoginErrorEl();
    const form = document.getElementById('login-form');
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
    form?.classList.add('is-error');
    if (!usernameInput?.value?.trim()) usernameInput?.setAttribute('aria-invalid', 'true');
    if (!passwordInput?.value) passwordInput?.setAttribute('aria-invalid', 'true');
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
    document.getElementById('login-username')?.removeAttribute('aria-invalid');
    document.getElementById('login-password')?.removeAttribute('aria-invalid');
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
      const icon = document.getElementById('login-password-toggle-icon');
      if (icon) {
        icon.setAttribute('data-lucide', isHidden ? 'eye-off' : 'eye');
        window.refreshLucideIcons?.(toggle);
      }
    });
  }

  function bindLoginFieldValidators() {
    const V = window.DentaFlowValidators;
    if (!V) return;
    V.bindField(document.getElementById('login-username'), 'username', { required: true });
    V.bindField(document.getElementById('login-password'), 'password', { required: true });
  }

  function validateLoginFields() {
    const V = window.DentaFlowValidators;
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    if (!V) {
      const username = usernameInput?.value?.trim() ?? '';
      const password = passwordInput?.value ?? '';
      if (!username || username.length < 3 || username.length > 50) {
        showLoginError('Identifiant requis (min. 3 caractères)');
        return false;
      }
      if (!password || password.length < 6) {
        showLoginError('Mot de passe requis (min. 6 caractères)');
        return false;
      }
      return true;
    }
    const userOk = V.validateInput(usernameInput, 'username', { required: true });
    const passOk = V.validateInput(passwordInput, 'password', { required: true });
    if (!userOk || !passOk) {
      if (!userOk) usernameInput?.focus();
      else passwordInput?.focus();
      return false;
    }
    return true;
  }

  function setupLoginForm() {
    const form = document.getElementById('login-form');
    if (!form || form.dataset.bound === 'true') return;
    form.dataset.bound = 'true';
    bindLoginFieldValidators();

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!validateLoginFields()) return;
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

    if (!validateLoginFields()) return;

    isSubmitting = true;
    setSubmitLoading(true);

    try {
      const response = await fetch(AUTH_ENDPOINT, {
        method: 'POST',
        credentials: 'include',
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
      if (!payload?.ok) {
        showLoginError('Identifiants incorrects.');
        return;
      }

      sessionStorage.setItem(SESSION_ROLE_KEY, payload.role || selectedRole);

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

  function showLoginGate() {
    initLoginReveal();
    setupRoleSelector();
    setupPasswordToggle();
    setupLoginForm();
  }

  async function validateSession() {
    try {
      const role = getStoredRole();
      const response = await fetch('/api/auth/me', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ expectedRole: role }),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async function tryRestoreSession() {
    const session = await validateSession();
    if (!session?.ok) {
      clearSession();
      showLoginGate();
      return;
    }
    handleAuthSuccess(session.role);
  }

  async function initAuthGate() {
    if (authInitialized) return;
    authInitialized = true;

    if (document.body.classList.contains('mode-client')) return;

    // No auth gate marker + no session → hard redirect to login entry.
    if (!document.body.classList.contains('auth-gate-active')) {
      if (!isAuthenticated()) {
        clearSession();
        window.location.replace(getLoginHref());
      }
      return;
    }

    await tryRestoreSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initAuthGate());
  } else {
    initAuthGate();
  }

  function getBearerToken() {
    return '';
  }

  function getStoredRole() {
    try {
      return sessionStorage.getItem(SESSION_ROLE_KEY) || '';
    } catch {
      return '';
    }
  }

  function isAuthenticated() {
    return Boolean(getStoredRole());
  }

  /** Alias used by dashboard modules for explicit session probes. */
  function checkSession() {
    return isAuthenticated();
  }

  function getLoginHref() {
    // Login lives on the same entry document (overlay gate), not a separate login.html.
    return `${window.location.pathname}${window.location.search}`;
  }

  function buildAuthHeaders(extra = {}) {
    return {
      Accept: 'application/json',
      ...extra,
    };
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(SESSION_ROLE_KEY);
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
    } catch { /* private browsing / disabled storage */ }
  }

  function registerLogoutTeardown(fn) {
    if (typeof fn === 'function') logoutTeardowns.push(fn);
  }

  function createUnauthorizedError(message) {
    const err = new Error(message || 'Session expirée — reconnectez-vous.');
    err.code = 'UNAUTHORIZED';
    return err;
  }

  /**
   * Strict route guard: protected shells must not initialize without a token.
   * Returns false when navigation/redirect was triggered.
   */
  function enforceRouteGuard() {
    if (document.body.classList.contains('mode-client')) return true;

    // Auth gate page may render login UI while unauthenticated.
    if (document.body.classList.contains('auth-gate-active')) {
      return isAuthenticated();
    }

    if (!isAuthenticated()) {
      clearSession();
      window.location.replace(getLoginHref());
      return false;
    }

    return true;
  }

  /**
   * Call before any protected data fetch. Throws after starting logout/redirect.
   */
  function requireSession() {
    if (isAuthenticated()) return true;
    void logout();
    throw createUnauthorizedError();
  }

  /**
   * Mid-session 401 interceptor — never fall through to "Mode dégradé".
   */
  function assertAuthorizedResponse(response) {
    if (response && response.status === 401) {
      void logout();
      throw createUnauthorizedError();
    }
    return response;
  }

  function isUnauthorizedError(error) {
    return Boolean(
      error &&
      (error.code === 'UNAUTHORIZED' ||
        /session expir[eé]e|unauthorized|401/i.test(String(error.message || '')))
    );
  }

  async function logout() {
    if (isLoggingOut) return;
    isLoggingOut = true;

    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
    } catch { /* proceed even if logout fails */ }

    clearSession();

    for (const teardown of logoutTeardowns) {
      try {
        await teardown();
      } catch { /* proceed */ }
    }

    if (typeof window.onDentaFlowLogout === 'function') {
      try {
        await window.onDentaFlowLogout();
      } catch { /* always proceed to login redirect */ }
    }

    window.location.replace(getLoginHref());
  }

  async function unlockDoctorModule() {
    if (!enforceRouteGuard() || !isAuthenticated()) {
      void logout();
      return;
    }

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
    if (!enforceRouteGuard() || !isAuthenticated()) {
      void logout();
      return;
    }

    document.body.classList.add('mode-assistant');
    document.body.classList.remove('mode-doctor');
    await isolateAssistantShell();

    if (typeof window.initializeAssistantDashboard === 'function') {
      window.initializeAssistantDashboard();
    }
  }

  window.DentaFlowAuth = {
    SESSION_ROLE_KEY,
    SESSION_TOKEN_KEY,
    getRole: getStoredRole,
    getToken: getBearerToken,
    getAuthHeaders: buildAuthHeaders,
    isAuthenticated,
    checkSession,
    enforceRouteGuard,
    requireSession,
    assertAuthorizedResponse,
    isUnauthorizedError,
    clearSession,
    registerLogoutTeardown,
    logout,
  };
})();
