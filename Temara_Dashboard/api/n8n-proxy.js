/**
 * Dashboard KPI proxy — bridges the static frontend to n8n via Ngrok.
 * Secrets live in Vercel Environment Variables only (never on the client).
 */
const UPSTREAM_TIMEOUT_MS = 8_000;
const DEFAULT_WEBHOOK_URL =
  'https://glade-rigor-perennial.ngrok-free.dev/webhook/dashboard-data';

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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const webhookUrl = process.env.N8N_WEBHOOK_ASSISTANT_PROXY || DEFAULT_WEBHOOK_URL;
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
};
