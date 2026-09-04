/**
 * DentaFlow OS — tenant session hydration for staff shells.
 * Reads the verified user from POST /api/auth/me and applies clinic branding.
 */
(function () {
  'use strict';

  const SESSION_USER_KEY = 'dentaflow_session_user';
  const DEFAULT_TITLE = 'DentaFlow OS';
  const TOKEN_NAME_RE = /^--[a-zA-Z0-9-]+$/;
  const TOKEN_UNSAFE_RE = /url\s*\(|expression\s*\(|javascript:|@import/i;
  const LEGACY_STAFF_NAMES = new Set([
    'sanae amrani',
    'sanae',
    'dr. tazi',
    'dr tazi',
    'dr. amrani',
    'dr amrani',
    'dr. sanae amrani',
    'dr sanae amrani',
  ]);

  let currentUser = null;
  let initPromise = null;

  function isLegacyStaffName(value) {
    return LEGACY_STAFF_NAMES.has(String(value || '').trim().toLowerCase());
  }

  function parseThemeTokens(raw) {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        return {};
      }
    }
    return {};
  }

  function pickString(...values) {
    for (const value of values) {
      const text = String(value || '').trim();
      if (text) return text;
    }
    return '';
  }

  function normalizeUser(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const nestedClinic = raw.clinic && typeof raw.clinic === 'object' ? raw.clinic : {};
    const role = pickString(raw.role).toLowerCase();
    const clinicSlug = pickString(
      raw.clinicSlug,
      raw.clinic_slug,
      raw.slug,
      nestedClinic.slug
    );
    const clinicName = pickString(
      raw.clinicName,
      raw.clinic_name,
      nestedClinic.name,
      nestedClinic.clinicName
    );
    const displayName = pickString(raw.displayName, raw.display_name, raw.name);
    const themePreset = pickString(
      raw.themePreset,
      raw.theme_preset,
      nestedClinic.themePreset,
      nestedClinic.theme_preset
    );
    const themeTokens = parseThemeTokens(
      raw.themeTokens || raw.theme_tokens || nestedClinic.themeTokens || nestedClinic.theme_tokens
    );

    if (!role && !clinicSlug && !clinicName && !displayName) return null;

    return {
      sub: raw.sub || raw.id || '',
      role,
      clinicSlug,
      clinicName,
      displayName,
      themePreset,
      themeTokens,
    };
  }

  function mergeUsers(...sources) {
    const merged = {
      sub: '',
      role: '',
      clinicSlug: '',
      clinicName: '',
      displayName: '',
      themePreset: '',
      themeTokens: {},
    };
    sources.forEach((source) => {
      const user = normalizeUser(source);
      if (!user) return;
      if (user.sub) merged.sub = user.sub;
      if (user.role) merged.role = user.role;
      if (user.clinicSlug) merged.clinicSlug = user.clinicSlug;
      if (user.clinicName) merged.clinicName = user.clinicName;
      if (user.displayName) merged.displayName = user.displayName;
      if (user.themePreset) merged.themePreset = user.themePreset;
      if (user.themeTokens && Object.keys(user.themeTokens).length) {
        merged.themeTokens = user.themeTokens;
      }
    });
    return merged.role || merged.clinicSlug || merged.clinicName || merged.displayName
      ? merged
      : null;
  }

  function readCachedUser() {
    try {
      const raw = sessionStorage.getItem(SESSION_USER_KEY);
      return raw ? normalizeUser(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  function writeCachedUser(user) {
    if (!user) return;
    try {
      sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
    } catch {
      /* private browsing */
    }
  }

  function clearCachedUser() {
    currentUser = null;
    initPromise = null;
    try {
      sessionStorage.removeItem(SESSION_USER_KEY);
    } catch {
      /* ignore */
    }
  }

  function applyThemeTokens(tokens) {
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return;
    const root = document.documentElement;
    Object.keys(tokens).forEach((key) => {
      const name = key.indexOf('--') === 0 ? key : `--${key}`;
      if (!TOKEN_NAME_RE.test(name)) return;
      const value = String(tokens[key] ?? '').trim();
      if (!value || TOKEN_UNSAFE_RE.test(value)) return;
      root.style.setProperty(name, value);
    });
  }

  function setTextContent(el, value) {
    if (!el) return;
    el.textContent = value;
  }

  function applyClinicName(clinicName) {
    const name = String(clinicName || '').trim() || DEFAULT_TITLE;
    document.querySelectorAll('[data-clinic-name], #clinic-title, .clinic-name-display').forEach((el) => {
      setTextContent(el, name);
    });

    const sms = document.getElementById('sms-campaign-body');
    if (sms) {
      sms.placeholder = `Bonjour, la ${name} vous informe que…`;
    }
  }

  function applyStaffName(displayName, role) {
    const name = String(displayName || '').trim();
    if (!name) return;
    if (role && role !== 'assistant' && role !== 'doctor') {
      /* still apply to placeholders */
    }

    document.querySelectorAll('[data-staff-name]').forEach((el) => {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (!el.value || isLegacyStaffName(el.value)) el.value = name;
        return;
      }
      setTextContent(el, name);
    });

    const profileName = document.getElementById('profile-name');
    const heroName = document.getElementById('hero-profile-name');
    const settingsName = document.getElementById('settings-profile-name');
    const avatar = document.getElementById('profile-avatar');

    if (profileName) setTextContent(profileName, name);
    if (heroName) setTextContent(heroName, name);
    if (settingsName && (!settingsName.value || isLegacyStaffName(settingsName.value))) {
      settingsName.value = name;
    }
    if (avatar) {
      const parts = name.split(/\s+/).filter(Boolean);
      const initials = parts
        .slice(0, 2)
        .map((part) => part.replace(/\./g, '')[0] || '')
        .join('')
        .toUpperCase()
        .slice(0, 2);
      if (initials) avatar.textContent = initials;
    }
  }

  function applySessionToUI(user) {
    const session = normalizeUser(user);
    if (!session) return session;

    currentUser = session;
    writeCachedUser(session);

    const clinicName = session.clinicName || DEFAULT_TITLE;
    document.title = `${clinicName} — DentaFlow OS`;
    applyClinicName(clinicName);

    if (session.themePreset) {
      document.documentElement.setAttribute('data-theme', session.themePreset);
    }
    if (session.themeTokens) applyThemeTokens(session.themeTokens);

    if (session.displayName) {
      applyStaffName(session.displayName, session.role);
    }

    return session;
  }

  async function fetchMe() {
    const response = await fetch('/api/auth/me', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  async function fetchPublicClinic(slug) {
    if (!slug) return null;
    try {
      const response = await fetch(`/api/public/clinic/${encodeURIComponent(slug)}`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null);
      const clinic = payload && payload.clinic;
      if (!clinic) return null;
      return {
        clinicName: clinic.name,
        clinicSlug: clinic.slug,
        themePreset: clinic.themePreset,
        themeTokens: clinic.themeTokens,
      };
    } catch {
      return null;
    }
  }

  async function initAuthenticatedSession() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const cached = readCachedUser();
      const payload = await fetchMe();
      if (!payload || payload.ok === false) {
        clearCachedUser();
        return null;
      }

      let user = mergeUsers(cached, payload, payload.user);
      if (user && user.clinicSlug && (!user.clinicName || !user.themePreset)) {
        const clinic = await fetchPublicClinic(user.clinicSlug);
        user = mergeUsers(user, clinic);
      }

      if (!user) return null;
      return applySessionToUI(user);
    })();

    try {
      return await initPromise;
    } catch (error) {
      initPromise = null;
      throw error;
    }
  }

  function captureAuthUser(payload) {
    const user = mergeUsers(currentUser, readCachedUser(), payload, payload && payload.user);
    if (!user) return;
    currentUser = user;
    writeCachedUser(user);
    applySessionToUI(user);
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function dentaflowSessionFetch(input, init) {
    const response = await originalFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (!url || typeof url !== 'string') return response;
      const path = url.split('?')[0];
      if (!/\/api\/auth\/?$/.test(path) && !/\/api\/auth$/.test(path.replace(/\/$/, ''))) {
        return response;
      }
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method !== 'POST' || !response.ok) return response;
      const clone = response.clone();
      const payload = await clone.json().catch(() => null);
      if (payload && payload.ok && payload.user) captureAuthUser(payload);
    } catch {
      /* never break auth */
    }
    return response;
  };

  function patchDoctorBoot() {
    const orig = window.initializeDoctorDashboard;
    if (typeof orig !== 'function' || orig.__dentaflowSessionPatched) return;
    async function wrapped() {
      orig.apply(this, arguments);
      try {
        await initAuthenticatedSession();
      } catch {
        /* shell already rendered with placeholders */
      }
    }
    wrapped.__dentaflowSessionPatched = true;
    window.initializeDoctorDashboard = wrapped;
    window.bootDoctorDashboard = wrapped;
  }

  function bindAuthHooks() {
    window.DentaFlowAuth?.registerLogoutTeardown?.(clearCachedUser);
    patchDoctorBoot();
  }

  bindAuthHooks();

  window.DentaFlowSession = {
    initAuthenticatedSession,
    applySessionToUI,
    applyThemeTokens,
    getUser() {
      return currentUser || readCachedUser();
    },
    isLegacyStaffName,
    clear: clearCachedUser,
  };
})();
