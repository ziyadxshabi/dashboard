/**
 * Synchronous theme boot — runs before first paint. Keep tiny (CSP script-src 'self').
 * Canonical key: dentaflow_assistant_prefs.theme. Migrates legacy doctor_theme.
 */
(function () {
  'use strict';
  var PREFS_KEY = 'dentaflow_assistant_prefs';
  var LEGACY_KEY = 'doctor_theme';
  var theme = 'pearl-clinic';

  function normalize(value) {
    if (value === 'dark' || value === 'oak-lounge') return 'oak-lounge';
    if (value === 'light' || value === 'pearl-clinic') return 'pearl-clinic';
    return '';
  }

  try {
    var prefs = {};
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) prefs = JSON.parse(raw) || {};
    } catch (prefsErr) {
      prefs = {};
    }
    var fromPrefs = normalize(prefs && prefs.theme);
    var fromLegacy = '';
    try {
      fromLegacy = normalize(localStorage.getItem(LEGACY_KEY));
    } catch (legacyErr) {
      fromLegacy = '';
    }
    theme = fromPrefs || fromLegacy || 'pearl-clinic';
    if (!fromPrefs && fromLegacy) {
      prefs.theme = theme;
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    }
    if (fromLegacy) {
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch (bootErr) {
    theme = 'pearl-clinic';
  }
  try {
    document.documentElement.setAttribute('data-theme', theme);
  } catch (attrErr) {
    /* ignore */
  }
})();
