/**
 * Waitlist proxy — JWT-gated bridge to n8n waitlist webhook.
 * POST adds a patient (never cached). GET reads the list (cached 20s).
 */
const { applyCors, requireBearerSession, withRequestLog } = require('./_lib/auth-crypto');
const { cacheGet, cacheSet, cacheKey } = require('./_lib/redis');

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res, 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    applyCors(res, 'GET, POST, OPTIONS');
    const session = requireBearerSession(req, res, { allowedRoles: ['assistant', 'doctor'] });
    if (!session) return;

    const key = cacheKey('waitlist', req);
    const cached = await cacheGet(key);
    if (cached) {
      req.dfCache = 'hit';
      return res.status(200).json(cached);
    }
    req.dfCache = 'miss';

    const webhookUrl = process.env.N8N_WAITLIST_WEBHOOK;
    const authKey = process.env.N8N_AGENCY_AUTH_KEY || process.env.N8N_AUTH_KEY;
    if (!webhookUrl || !authKey) {
      return res.status(500).json({ ok: false, error: 'Server configuration missing' });
    }

    try {
      const upstream = await fetch(webhookUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'ngrok-skip-browser-warning': 'true',
          'x-agency-auth': authKey,
        },
      });
      const text = await upstream.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : { ok: true, data: [] };
      } catch {
        payload = { ok: true, data: text };
      }
      if (!upstream.ok) {
        return res.status(upstream.status).json({
          ok: false,
          error: 'Unable to reach waitlist service',
        });
      }
      await cacheSet(key, payload, 20);
      return res.status(200).json(payload);
    } catch {
      return res.status(502).json({ ok: false, error: 'Unable to reach waitlist service' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const session = requireBearerSession(req, res, { allowedRoles: ['assistant'] });
  if (!session) return;

  const webhookUrl = process.env.N8N_WAITLIST_WEBHOOK;
  const authKey = process.env.N8N_AGENCY_AUTH_KEY || process.env.N8N_AUTH_KEY;

  if (!webhookUrl || !authKey) {
    return res.status(500).json({ ok: false, error: 'Server configuration missing' });
  }

  const body = req.body ?? {};
  const nom = typeof body.nom === 'string' ? body.nom.trim() : '';
  const telephone = typeof body.telephone === 'string' ? body.telephone.trim() : '';
  const priorite = typeof body.priorite === 'string' ? body.priorite.trim() : 'Normale';

  if (!nom || !telephone) {
    return res.status(400).json({ ok: false, error: 'nom and telephone are required' });
  }

  const payload = { nom, telephone, priorite };

  try {
    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'ngrok-skip-browser-warning': 'true',
        'x-agency-auth': authKey,
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json';

    res.setHeader('Content-Type', contentType);
    return res.status(upstream.status).send(text);
  } catch {
    return res.status(502).json({ ok: false, error: 'Unable to reach waitlist service' });
  }
}

module.exports = withRequestLog(handler);
