const err = $input.first()?.json ?? {};
const errMsg = (err.message ?? err.error ?? 'Internal error').toString();
const isAuth = errMsg.startsWith('AUTH_FAIL');
const isRate = errMsg.startsWith('RATE_LIMIT');

console.error('[Workflow] Error:', errMsg);

const now = new Date().toLocaleString('fr-MA', {
  timeZone: 'Africa/Casablanca',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

return [{
  json: {
    httpStatus: isAuth ? 401 : isRate ? 429 : 503,
    body: {
      ok: false,
      error: isAuth ? 'Unauthorized' : isRate ? 'Too Many Requests' : 'Service temporarily unavailable',
      message: isAuth ? 'Invalid or missing credentials'
        : isRate ? 'Brute-force protection triggered. Retry in 15 minutes.'
        : 'Upstream error. Retry shortly.',
      timestamp: now,
      trace_id: `err-${Date.now().toString(36)}`,
    },
  },
}];
