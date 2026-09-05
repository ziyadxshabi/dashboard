/**
 * Shared theme apply. Profile display name comes from the validated session.
 */
(function () {
  'use strict';

  function normalizeTheme(theme) {
    return theme === 'pearl-clinic' || theme === 'light' ? 'pearl-clinic' : 'oak-lounge';
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
    normalizeTheme,
    applyTheme,
    getSessionDisplayName,
    getSessionRoleLabel,
  };
})();
