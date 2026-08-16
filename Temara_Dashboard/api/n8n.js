/**
 * Combined n8n webhook proxies (single serverless function).
 *
 * Routes:
 *   GET  /api/n8n-proxy        → assistant/KPI proxy (N8N_WEBHOOK_ASSISTANT_PROXY)
 *   POST /api/n8n-delay-alert  → delay alert (N8N_WEBHOOK_DELAY_ALERT)
 *   POST /api/proxy            → misc targets (daily-report, bulk-confirm, …)
 *
 * Rewrites in vercel.json map those paths to /api/n8n?action=…
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 8_000;
const GENERIC_PROXY_TIMEOUT_MS = 30_000;

const GENERIC_PROXY_TARGET_ENV = {
  'daily-report-export': 'N8N_WEBHOOK_DAILY_REPORT_EXPORT',
  'force-reminders': 'N8N_WEBHOOK_FORCE_REMINDERS',
  'bulk-confirm': 'N8N_WEBHOOK_BULK_CONFIRM',
  'bulk-cancel': 'N8N_WEBHOOK_BULK_CANCEL',
};

function resolveN8nRoute(req) {
  const raw = String(req.url || '');
  let pathname = raw.split('?')[0];
  let action = '';
  try {
    const parsed = new URL(raw, 'http://localhost');
    pathname = parsed.pathname;
    action = parsed.searchParams.get('action') || '';
  } catch { /* use raw path */ }

  const headerPath = String(
    req.headers['x-invoke-path'] ||
    req.headers['x-matched-path'] ||
    req.headers['x-vercel-original-path'] ||
    ''
  );
  const combined = `${pathname} ${headerPath} ${raw} ${action}`.toLowerCase();

  if (combined.includes('delay-alert') || action === 'delay-alert') return 'delay-alert';
  if (combined.includes('n8n-proxy') || action === 'proxy') return 'proxy';
  if (combined.includes('/api/proxy') || action === 'generic-proxy') return 'generic-proxy';
  return null;
}

function isHtmlPayload(text, contentType) {
  const trimmed = (text ?? '').trim().toLowerCase();
  return (
    contentType.includes('text/html') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html') ||
    trimmed.includes('ngrok')
  );
}

function webhookHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid-url)';
  }
}

/** HTTP 200 + ok:false so the frontend can read `details` (avoids 500/502 blind spot). */
function respondUpstreamFailure(res, rawText, error = 'Upstream Error', meta = {}) {
  const details = (rawText ?? '').slice(0, 500) || 'No upstream body received';
  console.error('Upstream Raw Response:', rawText ?? '(empty)');

  return res.status(200).json({
    ok: false,
    error,
    details,
    _meta: meta,
  });
}

async function fetchUpstreamOnce(webhookUrl, authKey, attemptIndex) {
  const bypassVariants = [
    { 'ngrok-skip-browser-warning': '69420' },
    { 'ngrok-skip-browser-warning': 'true', cookie: 'ngrok-skip-browser-warning=true' },
    { 'ngrok-skip-browser-warning': '1', 'user-agent': 'DentaFlow-Vercel-Proxy/1.0' },
  ];
  const bypass = bypassVariants[attemptIndex] ?? bypassVariants[0];

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'DentaFlow-Vercel-Proxy/1.0',
        'x-agency-auth': authKey,
        ...bypass,
      },
      signal: abortController.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    const contentType = (response.headers.get('content-type') || '(none)').toLowerCase();
    const rawText = await response.text();

    return { response, contentType, rawText, attemptIndex, bypassKey: Object.keys(bypass).join(',') };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function fetchUpstreamWithRetry(webhookUrl, authKey) {
  const maxAttempts = 3;
  let lastResult = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await fetchUpstreamOnce(webhookUrl, authKey, attempt);
    lastResult = result;

    if (!isHtmlPayload(result.rawText, result.contentType)) {
      return { ...result, attemptsUsed: attempt + 1 };
    }
  }

  return { ...lastResult, attemptsUsed: maxAttempts, allHtml: true };
}

async function handleProxy(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['doctor'] });
  if (!session) return;

  const webhookUrl = process.env.N8N_WEBHOOK_ASSISTANT_PROXY;
  if (!webhookUrl) {
    return res.status(503).json({ ok: false, error: 'Webhook not configured' });
  }
  const authKey = process.env.N8N_AUTH_KEY;

  if (!authKey) {
    return res.status(500).json({
      ok: false,
      error: 'Server Configuration Error',
      details: 'Missing N8N_AUTH_KEY in Vercel Environment Variables.',
    });
  }

  const host = webhookHost(webhookUrl);

  try {
    const { response, contentType, rawText, attemptsUsed, allHtml, bypassKey } =
      await fetchUpstreamWithRetry(webhookUrl, authKey);

    const meta = { host, contentType, upstreamStatus: response.status, attemptsUsed, bypassKey };

    if (!response.ok) {
      return respondUpstreamFailure(
        res,
        rawText || `HTTP ${response.status} from upstream`,
        'Upstream HTTP Error',
        meta
      );
    }

    if (!rawText || !rawText.trim()) {
      return respondUpstreamFailure(
        res,
        '(empty response body — n8n webhook may have no Respond to Webhook node)',
        'Upstream Error',
        meta
      );
    }

    if (allHtml || isHtmlPayload(rawText, contentType)) {
      return respondUpstreamFailure(
        res,
        rawText,
        'Upstream Error',
        { ...meta, ngrokInterstitial: true }
      );
    }

    let parsedData;
    try {
      parsedData = JSON.parse(rawText);
    } catch {
      return respondUpstreamFailure(res, rawText, 'Upstream Error', meta);
    }

    return res.status(200).json({
      ok: true,
      data: parsedData,
    });
  } catch (err) {
    console.error('[n8n-proxy] Proxy request failed:', err);

    const isTimeout = err?.name === 'AbortError';
    const failText = isTimeout
      ? `Upstream request timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s`
      : (err?.message || 'Unknown proxy error');

    return respondUpstreamFailure(res, failText, 'Proxy Request Failed', { host });
  }
}

async function handleDelayAlert(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant'] });
  if (!session) return;

  const webhookUrl = process.env.N8N_WEBHOOK_DELAY_ALERT;
  if (!webhookUrl) {
    return res.status(503).json({ ok: false, error: 'Webhook not configured' });
  }
  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  if (!authKey) {
    console.error('[n8n-delay-alert] N8N_AUTH_KEY is not configured');
    return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
  }

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'ngrok-skip-browser-warning': 'true',
    'user-agent': 'DentaFlow-Assistant-Proxy/1.0',
    'x-agency-auth': authKey,
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body ?? {}),
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    const rawText = await response.text();
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = rawText;
    }

    if (!response.ok) {
      return res.status(200).json({
        ok: false,
        error: 'Upstream HTTP Error',
        details: rawText || `HTTP ${response.status}`,
        upstreamStatus: response.status,
      });
    }

    return res.status(200).json({ ok: true, data: parsed });
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError';
    return res.status(200).json({
      ok: false,
      error: isTimeout ? 'Upstream Timeout' : 'Proxy Request Failed',
      details: err?.message || 'Unknown proxy error',
    });
  }
}

async function handleGenericProxy(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'POST, OPTIONS');
    return res.status(204).end();
  }

  applyCors(res, 'POST, OPTIONS');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
  if (!session) return;

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? { ...req.body }
    : {};

  const target = String(body.target ?? '').trim();
  if (!target) {
    return res.status(400).json({ ok: false, error: 'target is required' });
  }

  const envKey = GENERIC_PROXY_TARGET_ENV[target];
  if (!envKey) {
    return res.status(400).json({ ok: false, error: 'Unknown target' });
  }

  const webhookUrl = String(process.env[envKey] ?? '').trim();
  if (!webhookUrl) {
    return res.status(503).json({ ok: false, error: 'Server configuration missing' });
  }

  const authKey = String(process.env.N8N_AUTH_KEY ?? process.env.DASHBOARD_AUTH_KEY ?? '').trim();
  delete body.target;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), GENERIC_PROXY_TIMEOUT_MS);

  try {
    const headers = {
      accept: '*/*',
      'content-type': 'application/json',
      'user-agent': 'DentaFlow-Misc-Proxy/1.0',
    };
    if (authKey) {
      headers['x-agency-auth'] = authKey;
    }

    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) {
      res.setHeader('Content-Disposition', disposition);
    }
    return res.send(buffer);
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError';
    return res.status(502).json({
      ok: false,
      error: isTimeout ? 'Upstream Timeout' : 'Proxy Request Failed',
      details: err?.message || 'Unknown proxy error',
    });
  }
}

async function handler(req, res) {
  const route = resolveN8nRoute(req);
  if (route === 'delay-alert') return handleDelayAlert(req, res);
  if (route === 'proxy') return handleProxy(req, res);
  if (route === 'generic-proxy') return handleGenericProxy(req, res);
  return res.status(404).json({ ok: false, error: 'Not found' });
}

module.exports = withRequestLog(handler);
