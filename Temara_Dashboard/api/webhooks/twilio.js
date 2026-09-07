/**
 * Twilio inbound — SMS/WhatsApp Body, status callbacks, Voice IVR (Hobby 12th function).
 * Public endpoint. Auth: X-Twilio-Signature (fail-closed when token is set).
 *
 * POST /api/webhooks/twilio
 */
'use strict';

const { query } = require('../_lib/db');
const { tryAcquireLock, incrementRateLimit } = require('../_lib/notification-locks');
const { toE164MA, isValidMaMobileE164 } = require('../_lib/phone-e164');
const {
  twilioCredentials,
  canonicalTwilioUrl,
  verifyTwilioSignature,
  clinicBookingUrl,
  loadClinicSmsConfig,
  stripWhatsappPrefix,
} = require('../_lib/twilio');
const { dispatchSms, updateSmsStatusBySid, persistSmsRow } = require('../_lib/notify');
const { voicePortalSms } = require('../_lib/sms-templates');
const { markInboundAt, setSmsConsentByPhone } = require('../_lib/patients');

const DELIVERY_STATUSES = new Set([
  'queued',
  'accepted',
  'sending',
  'sent',
  'delivered',
  'undelivered',
  'failed',
  'read',
]);

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(say, status = 200) {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Response>\n` +
    `    <Say language="fr-FR" voice="Polly.Celine">${escapeXml(say)}</Say>\n` +
    `    <Hangup/>\n` +
    `</Response>`;
  return { status, xml };
}

function twimlGather(actionUrl) {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Response>\n` +
    `    <Gather numDigits="1" timeout="8" method="POST" action="${escapeXml(actionUrl)}">\n` +
    `        <Say language="fr-FR" voice="Polly.Celine">${escapeXml('Pour réserver en ligne, appuyez sur 1.')}</Say>\n` +
    `    </Gather>\n` +
    `    <Say language="fr-FR" voice="Polly.Celine">${escapeXml("Nous n'avons pas reçu de choix. Au revoir.")}</Say>\n` +
    `    <Hangup/>\n` +
    `</Response>`;
  return { status: 200, xml };
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

function foldInbound(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function inboundIntent(text) {
  const folded = foldInbound(text);
  if (!folded) return 'ignored';
  if (folded === 'stop' || folded === 'arret' || folded === 'unsubscribe') return 'stop';
  if (folded === '1' || folded === 'oui' || folded === 'ok' || folded === 'confirme' || folded === 'yes') {
    return 'confirm';
  }
  return 'ignored';
}

async function clinicIdForPhone(e164) {
  const result = await query(
    `SELECT clinic_id FROM bookings
     WHERE COALESCE(booking_kind, 'visit') = 'visit'
       AND starts_at > NOW()
       AND status::text = 'Confirme'
       AND (
         public.normalize_ma_e164(patient_phone) = $1
         OR regexp_replace(COALESCE(patient_phone, ''), '[^0-9+]', '', 'g') = $1
       )
     ORDER BY starts_at ASC
     LIMIT 1`,
    [e164]
  );
  if (result.rows[0]?.clinic_id) return result.rows[0].clinic_id;
  const patient = await query(
    `SELECT clinic_id FROM patients WHERE phone_e164 = $1 ORDER BY updated_at DESC LIMIT 1`,
    [e164]
  );
  return patient.rows[0]?.clinic_id || (await defaultClinicId());
}

async function confirmNextVisit(clinicId, e164) {
  const updated = await query(
    `UPDATE bookings
     SET patient_confirmed_at = COALESCE(patient_confirmed_at, NOW()),
         confirmation_state = 'confirmed',
         updated_at = NOW()
     WHERE id = (
       SELECT id FROM bookings
       WHERE clinic_id = $1
         AND COALESCE(booking_kind, 'visit') = 'visit'
         AND status::text = 'Confirme'
         AND starts_at > NOW()
         AND (
           public.normalize_ma_e164(patient_phone) = $2
           OR regexp_replace(COALESCE(patient_phone, ''), '[^0-9+]', '', 'g') = $2
         )
       ORDER BY starts_at ASC
       LIMIT 1
     )
     RETURNING id, starts_at, patient_confirmed_at`,
    [clinicId, e164]
  );
  return updated.rows[0] || null;
}

async function handleInboundBody({ e164, text, req }) {
  const clinicId = await clinicIdForPhone(e164);
  await markInboundAt(clinicId, e164);
  try {
    await persistSmsRow({
      clinicId,
      purpose: 'inbound',
      toPhone: e164,
      body: text,
      sid: null,
      status: 'received',
    });
  } catch {
    // fail-open
  }

  const intent = inboundIntent(text);
  if (intent === 'stop') {
    const consent = await setSmsConsentByPhone(e164, false);
    return { ok: true, action: 'stop', ...consent };
  }
  if (intent === 'confirm') {
    const booking = await confirmNextVisit(clinicId, e164);
    return { ok: true, action: 'confirm', bookingId: booking?.id || null };
  }
  return { ok: true, action: 'ignored' };
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
  const inboundText = String(body.Body ?? '').trim();
  const digits = String(body.Digits || '').trim();
  const fromRaw = String(body.From || '').trim();
  const fromPhone = toE164MA(stripWhatsappPrefix(fromRaw));
  const callSid = String(body.CallSid || '').trim();
  const isDelivery = DELIVERY_STATUSES.has(messageStatus.toLowerCase());

  if (inboundText && !callSid && !isDelivery) {
    const e164 = isValidMaMobileE164(fromPhone) ? fromPhone : toE164MA(fromRaw);
    if (!isValidMaMobileE164(e164)) {
      return res.status(200).json({ ok: false, action: 'ignored', reason: 'invalid_phone' });
    }
    const rate = await incrementRateLimit(`ratelimit:twilio-sms:${e164}`, 8, 60);
    if (rate.ok && rate.blocked) {
      return res.status(200).json({ ok: false, action: 'rate_limited' });
    }
    try {
      const result = await handleInboundBody({ e164, text: inboundText, req });
      return res.status(200).json(result);
    } catch (err) {
      console.error('[twilio-inbound]', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Inbound parse failed' });
    }
  }

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

  const rate = await incrementRateLimit(`ratelimit:twilio:${fromPhone || fromRaw || 'unknown'}`, 5, 60);
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

  if (callSid && !digits) {
    return sendXml(res, twimlGather(webhookUrl));
  }

  return sendXml(res, TWI_FALLBACK);
};
