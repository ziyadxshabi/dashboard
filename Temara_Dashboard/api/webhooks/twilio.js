/**
 * Twilio inbound — SMS status callbacks + Voice IVR (Hobby 12th function).
 * Public endpoint. Auth: X-Twilio-Signature (fail-closed when token is set).
 *
 * POST /api/webhooks/twilio
 */
'use strict';

const { query } = require('../_lib/db');
const { tryAcquireLock, incrementRateLimit } = require('../_lib/notification-locks');
const {
  twilioCredentials,
  canonicalTwilioUrl,
  verifyTwilioSignature,
  clinicBookingUrl,
  loadClinicSmsConfig,
} = require('../_lib/twilio');
const { dispatchSms, updateSmsStatusBySid } = require('../_lib/notify');
const { voicePortalSms } = require('../_lib/sms-templates');

function twiml(say, status = 200) {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Response>\n` +
    `    <Say language="fr-FR" voice="Polly.Celine">${say}</Say>\n` +
    `    <Hangup/>\n` +
    `</Response>`;
  return { status, xml };
}

const TWI_OK = twiml('Parfait. Le lien de réservation vient de vous être envoyé par SMS. À très bientôt.');
const TWI_FALLBACK = twiml("Nous n'avons pas reconnu votre choix. Veuillez raccrocher et rappeler. Au revoir.");
const TWI_ERROR = twiml("Une erreur inattendue s'est produite. Veuillez rappeler ultérieurement. Merci.", 403);

function sendXml(res, payload) {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  return res.status(payload.status).end(payload.xml);
}

async function defaultClinicId() {
  const result = await query(`SELECT id FROM clinics WHERE slug = 'temara' LIMIT 1`);
  return result.rows[0]?.id || null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return sendXml(res, TWI_ERROR);
  }

  const { authToken } = twilioCredentials();
  const webhookUrl = canonicalTwilioUrl(req, '/api/webhooks/twilio');
  if (authToken && !verifyTwilioSignature(req, authToken, webhookUrl)) {
    return sendXml(res, TWI_ERROR);
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const messageSid = String(body.MessageSid || body.SmsSid || '').trim();
  const messageStatus = String(body.MessageStatus || body.SmsStatus || '').trim();
  const digits = String(body.Digits || '').trim();
  const fromPhone = String(body.From || '').trim();
  const callSid = String(body.CallSid || '').trim();

  if (messageSid && !callSid) {
    const lock = await tryAcquireLock(`lock:twilio-sms:${messageSid}`, 86400);
    if (lock.duplicate) {
      return res.status(200).json({ ok: true, duplicate: true });
    }
    try {
      await updateSmsStatusBySid(messageSid, messageStatus || 'unknown');
    } catch (err) {
      console.error('[twilio-status]', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Status update failed' });
    }
    return res.status(200).json({ ok: true, messageSid, status: messageStatus || 'unknown' });
  }

  const rate = await incrementRateLimit(`ratelimit:twilio:${fromPhone || 'unknown'}`, 5, 60);
  if (rate.ok && rate.blocked) {
    return sendXml(res, TWI_ERROR);
  }

  if (!fromPhone.startsWith('+') || !/^\+[1-9]\d{6,14}$/.test(fromPhone)) {
    return sendXml(res, TWI_ERROR);
  }
  if (digits && !/^[0-9]$/.test(digits)) {
    return sendXml(res, TWI_FALLBACK);
  }

  if (digits === '1') {
    try {
      const clinicId = await defaultClinicId();
      const clinic = await loadClinicSmsConfig(clinicId);
      const url = clinicBookingUrl(clinic, req);
      await dispatchSms({
        clinicId,
        purpose: 'voice_portal',
        to: fromPhone,
        body: voicePortalSms(url),
        req,
        lockKey: `sms:voice:${fromPhone}:${new Date().toISOString().slice(0, 10)}`,
      });
    } catch (err) {
      console.error('[twilio-voice]', err?.message || err);
    }
    return sendXml(res, TWI_OK);
  }

  return sendXml(res, TWI_FALLBACK);
};
