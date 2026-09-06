/**
 * Shared theme apply. Profile display name comes from the validated session.
 * Theme preference lives in dentaflow_assistant_prefs.theme for every role.
 */
(function () {
  'use strict';

  const THEME_PREFS_KEY = 'dentaflow_assistant_prefs';
  const LEGACY_THEME_KEY = 'doctor_theme';

  function normalizeTheme(theme) {
    return theme === 'pearl-clinic' || theme === 'light' ? 'pearl-clinic' : 'oak-lounge';
  }

  function parseStoredTheme(value) {
    if (value === 'dark' || value === 'oak-lounge') return 'oak-lounge';
    if (value === 'light' || value === 'pearl-clinic') return 'pearl-clinic';
    return '';
  }

  function readPrefsObject() {
    try {
      const raw = localStorage.getItem(THEME_PREFS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function readStoredTheme() {
    const fromPrefs = parseStoredTheme(readPrefsObject().theme);
    if (fromPrefs) return fromPrefs;
    try {
      const fromLegacy = parseStoredTheme(localStorage.getItem(LEGACY_THEME_KEY));
      if (fromLegacy) {
        writeStoredTheme(fromLegacy);
        return fromLegacy;
      }
    } catch { /* private browsing / disabled storage */ }
    return 'pearl-clinic';
  }

  function writeStoredTheme(theme) {
    const resolved = normalizeTheme(theme);
    try {
      const prefs = readPrefsObject();
      prefs.theme = resolved;
      localStorage.setItem(THEME_PREFS_KEY, JSON.stringify(prefs));
      localStorage.removeItem(LEGACY_THEME_KEY);
    } catch { /* private browsing / disabled storage */ }
    return resolved;
  }

  function applyTheme(theme) {
    const resolved = normalizeTheme(theme);
    document.documentElement.setAttribute('data-theme', resolved);
    return resolved;
  }

  function getSessionDisplayName() {
    const user = window.DentaFlowAuth?.getSessionUser?.();
    return String(user?.displayName || user?.display_name || '').trim();
  }

  function getSessionRoleLabel(role) {
    const resolved = String(role || window.DentaFlowAuth?.getRole?.() || '').toLowerCase();
    if (resolved === 'assistant') return 'Assistante dentaire';
    return 'Chirurgien-dentiste';
  }

  window.DentaFlowTheme = {
    THEME_PREFS_KEY,
    normalizeTheme,
    applyTheme,
    readStoredTheme,
    writeStoredTheme,
    getSessionDisplayName,
    getSessionRoleLabel,
  };
})();
