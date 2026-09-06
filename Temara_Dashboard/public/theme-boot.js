/**
 * Synchronous theme boot — runs before first paint. Keep tiny (CSP script-src 'self').
 * Default: pearl-clinic (light canvas). Honors stored doctor/assistant prefs.
 */
(function () {
  'use strict';
  var theme = 'pearl-clinic';
  try {
    var stored = localStorage.getItem('doctor_theme');
    if (stored === 'dark') {
      theme = 'oak-lounge';
    } else if (stored === 'light') {
      theme = 'pearl-clinic';
    } else {
      var raw = localStorage.getItem('dentaflow_assistant_prefs');
      if (raw) {
        var parsed = JSON.parse(raw);
        var pref = parsed && parsed.theme;
        if (pref === 'oak-lounge' || pref === 'dark') theme = 'oak-lounge';
        else if (pref === 'pearl-clinic' || pref === 'light') theme = 'pearl-clinic';
      }
    }
  } catch {
    theme = 'pearl-clinic';
  }
  try {
    document.documentElement.setAttribute('data-theme', theme);
  } catch {
    /* ignore */
  }
})();
