/**
 * DentaFlow OS — centralized role + PIN authentication gate.
 * Dispatches to POST /api/auth; unlocks Doctor or Assistant modules on success.
 */
(function () {
  'use strict';

  const AUTH_ENDPOINT = '/api/auth';
  const SESSION_ROLE_KEY = 'dentaflow_role';
  const SESSION_TOKEN_KEY = 'dentaflow_session';
  const SESSION_PIN_KEY = 'dentaflow_pin';

  let currentPin = '';
  let selectedRole = 'doctor';
  let authInitialized = false;

  function initLoginReveal() {
    const card = document.getElementById('login-card');
    if (!card) return;
    requestAnimationFrame(() => {
      card.classList.add('login-assembled');
    });
  }

  function updatePinDots() {
    document.querySelectorAll('.pin-dot').forEach((dot, index) => {
      dot.classList.toggle('is-filled', index < currentPin.length);
    });
  }

  function resetPinDots() {
    currentPin = '';
    const dotsEl = document.getElementById('pin-dots');
    dotsEl?.classList.remove('is-error', 'is-shaking');
    updatePinDots();
  }

  function showInvalidPinFeedback() {
    const dotsEl = document.getElementById('pin-dots');
    const errorEl = document.getElementById('login-error');
    dotsEl?.classList.add('is-error', 'is-shaking');
    if (errorEl) {
      errorEl.textContent = 'Code incorrect';
      errorEl.hidden = false;
    }

    setTimeout(() => {
      dotsEl?.classList.remove('is-error', 'is-shaking');
      resetPinDots();
      if (errorEl) errorEl.hidden = true;
    }, 650);
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
      doctorBtn?.hidden = true;
      return;
    }

    setRole('doctor');
  }

  function setupKeypad() {
    const keypad = document.getElementById('pin-keypad');
    if (!keypad || keypad.dataset.bound === 'true') return;
    keypad.dataset.bound = 'true';

    keypad.addEventListener('click', (e) => {
      const btn = e.target.closest('.ios-key');
      if (!btn || btn.disabled) return;

      if (btn.id === 'key-delete') {
        currentPin = currentPin.slice(0, -1);
        updatePinDots();
        return;
      }

      if (btn.id === 'key-enter') {
        if (currentPin.length === 4) setTimeout(submitAuth, 80);
        return;
      }

      if (btn.dataset.digit && currentPin.length < 4) {
        currentPin += btn.dataset.digit;
        updatePinDots();
        if (currentPin.length === 4) {
          setTimeout(submitAuth, 120);
        }
      }
    });
  }

  async function submitAuth() {
    try {
      const response = await fetch(AUTH_ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ role: selectedRole, pin: currentPin }),
      });

      if (response.status === 401 || response.status === 403) {
        showInvalidPinFeedback();
        return;
      }

      if (!response.ok) {
        showInvalidPinFeedback();
        return;
      }

      const payload = await response.json();
      if (!payload?.ok) {
        showInvalidPinFeedback();
        return;
      }

      sessionStorage.setItem(SESSION_ROLE_KEY, selectedRole);

      await handleAuthSuccess(selectedRole);
    } catch {
      showInvalidPinFeedback();
    }
  }

  function dismissLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    overlay.classList.add('is-unlocking');
    setTimeout(() => overlay.remove(), 400);
  }

  function isolateDoctorShell() {
    document.getElementById('assistant-mount')?.replaceChildren();
    const assistantMount = document.getElementById('assistant-mount');
    if (assistantMount) assistantMount.hidden = true;

    const inlineAssistant = document.getElementById('assistant-shell');
    if (inlineAssistant) {
      inlineAssistant.hidden = true;
      inlineAssistant.remove();
    }

    const doctorShell = document.getElementById('doctor-shell');
    if (doctorShell) doctorShell.hidden = false;
  }

  async function isolateAssistantShell() {
    const doctorShell = document.getElementById('doctor-shell');
    if (doctorShell) {
      doctorShell.hidden = true;
      doctorShell.remove();
    }

    const inlineShell = document.getElementById('assistant-shell');
    if (inlineShell) {
      inlineShell.hidden = false;
      return;
    }

    const mount = document.getElementById('assistant-mount');
    if (!mount) return;

    if (!mount.childElementCount) {
      const response = await fetch('/assistant-shell.html', { cache: 'no-store' });
      if (!response.ok) throw new Error('Assistant shell unavailable');
      mount.innerHTML = await response.text();
    }

    mount.hidden = false;
  }

  async function unlockDoctorModule() {
    document.body.classList.add('mode-doctor');
    document.body.classList.remove('mode-assistant');
    isolateDoctorShell();

    if (typeof window.bootDoctorDashboard === 'function') {
      window.bootDoctorDashboard();
    }
    if (typeof window.unlockDashboard === 'function') {
      window.unlockDashboard();
    }
  }

  async function unlockAssistantModule() {
    document.body.classList.add('mode-assistant');
    document.body.classList.remove('mode-doctor');
    await isolateAssistantShell();

    if (typeof window.bootAssistantApp === 'function') {
      window.bootAssistantApp();
    }
  }

  async function handleAuthSuccess(role) {
    document.body.classList.remove('auth-gate-active');
    dismissLoginOverlay();

    if (role === 'assistant') {
      await unlockAssistantModule();
      return;
    }

    await unlockDoctorModule();
  }

  async function validateSession() {
    try {
      const response = await fetch('/api/auth/me', {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
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
      initLoginReveal();
      setupRoleSelector();
      setupKeypad();
      return;
    }
    handleAuthSuccess(session.role);
  }

  async function initAuthGate() {
    if (authInitialized) return;
    authInitialized = true;
    if (document.body.classList.contains('mode-client')) return;
    if (!document.body.classList.contains('auth-gate-active')) return;
    await tryRestoreSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initAuthGate());
  } else {
    initAuthGate();
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(SESSION_ROLE_KEY);
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      sessionStorage.removeItem(SESSION_PIN_KEY);
    } catch { /* private browsing */ }
  }

  window.DentaFlowAuth = {
    SESSION_ROLE_KEY,
    SESSION_TOKEN_KEY,
    SESSION_PIN_KEY,
    getRole: () => sessionStorage.getItem(SESSION_ROLE_KEY),
    getSession: () => sessionStorage.getItem(SESSION_TOKEN_KEY),
    clearSession,
    logout: async () => {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
      } catch { /* proceed */ }
      clearSession();
      window.location.reload();
    },
  };
})();
