/**
 * Waitlist proxy — keeps the n8n auth secret off the static client.
 * The dashboard is a static frontend on Vercel with no other backend;
 * this serverless function receives POST /api/waitlist and forwards
 * validated payloads to n8n with X-Agency-Auth attached server-side.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const webhookUrl = process.env.N8N_WAITLIST_WEBHOOK;
  const authKey = process.env.N8N_AGENCY_AUTH_KEY;

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
        'accept': 'application/json',
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
};
