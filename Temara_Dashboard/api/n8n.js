/**
 * n8n upstream gateway — JWT-gated KPI proxy.
 * Upstream failures always return HTTP 502 (never a fake 200).
 */
'use strict';

const { applyCors, requireBearerSession } = require('./_lib/auth-crypto');

const UPSTREAM_TIMEOUT_MS = 8_000;

function respondUpstreamError(res) {
  return res.status(502).json({
    ok: false,
    error: 'Upstream gateway error',
    code: 'UPSTREAM_ERROR',
  });
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

    return { response, contentType, rawText };
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
      return result;
    }
  }

  return { ...lastResult, allHtml: true };
}

async function handler(req, res) {
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

  try {
    const { response, contentType, rawText, allHtml } =
      await fetchUpstreamWithRetry(webhookUrl, authKey);

    if (!response.ok) {
      console.error('[n8n] Upstream HTTP Error:', rawText || `HTTP ${response.status}`);
      return respondUpstreamError(res);
    }

    if (!rawText || !rawText.trim()) {
      console.error('[n8n] empty upstream body');
      return respondUpstreamError(res);
    }

    if (allHtml || isHtmlPayload(rawText, contentType)) {
      console.error('[n8n] HTML/ngrok interstitial from upstream');
      return respondUpstreamError(res);
    }

    let parsedData;
    try {
      parsedData = JSON.parse(rawText);
    } catch {
      console.error('[n8n] invalid JSON from upstream');
      return respondUpstreamError(res);
    }

    return res.status(200).json({
      ok: true,
      data: parsedData,
    });
  } catch (err) {
    console.error('[n8n] Proxy request failed:', err);
    return respondUpstreamError(res);
  }
}

handler.respondUpstreamError = respondUpstreamError;
module.exports = handler;
