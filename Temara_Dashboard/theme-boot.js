/**
 * Synchronous theme boot — runs before first paint. Keep tiny (CSP script-src 'self').
 */
(function () {
  'use strict';
  try {
    document.documentElement.setAttribute('data-theme', 'oak-lounge');
  } catch {
    /* ignore */
  }
})();
