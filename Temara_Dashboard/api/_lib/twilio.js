'use strict';

const crypto = require('crypto');
const { query } = require('./db');
const { toE164MA, isValidMaMobileE164 } = require('./phone-e164');

const TWILIO_API = 'https://api.twilio.com/2010-04-01/Accounts';

function timingSafeEqualStrings(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function twilioCredentials() {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(
    process.env.TWILIO_AUTH_TOKEN || process.env.N8N_TWILIO_AUTH_TOKEN || ''
  ).trim();
  const fromNumber = String(
    process.env.TWILIO_FROM || process.env.TWILIO_FROM_NUMBER || ''
  ).trim();
  return { accountSid, authToken, fromNumber };
}

function isTwilioConfigured() {
  const { accountSid, authToken, fromNumber } = twilioCredentials();
  return Boolean(accountSid && authToken && fromNumber);
}

function publicBaseUrl(req) {
  const explicit = String(
    process.env.TWILIO_WEBHOOK_URL || process.env.PUBLIC_BASE_URL || ''
  ).trim().replace(/\/+$/, '');
  if (explicit) return explicit.replace(/\/api\/webhooks\/twilio$/i, '');
  const vercel = String(process.env.VERCEL_URL || '').trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '')}`;
  const host = req?.headers?.host;
  if (host) {
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    return `${proto}://${host}`;
  }
  return '';
}

function twilioStatusCallbackUrl(req) {
  const explicit = String(process.env.TWILIO_WEBHOOK_URL || '').trim();
  if (explicit) return explicit;
  const base = publicBaseUrl(req);
  return base ? `${base}/api/webhooks/twilio` : '';
}

function canonicalTwilioUrl(req, pathSuffix) {
  const base = String(
    process.env.TWILIO_WEBHOOK_URL || process.env.N8N_WEBHOOK_BASE_URL || publicBaseUrl(req)
  )
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/webhooks\/twilio$/i, '')
    .replace(/\/webhook\/.*$/i, '');
  const path = pathSuffix || '/api/webhooks/twilio';
  let url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const search = req?.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  if (search) {
    const params = new URLSearchParams(search);
    const keys = [...params.keys()].sort();
    const qs = keys
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params.get(key) || '')}`)
      .join('&');
    if (qs) url += `?${qs}`;
  }
  return url;
}

function verifyTwilioSignature(req, authToken, webhookUrl) {
  const header =
    req.headers['x-twilio-signature'] ||
    req.headers['X-Twilio-Signature'] ||
    '';
  const token = String(authToken || twilioCredentials().authToken || '').trim();
  if (!token || !header) return false;

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const sortedParams = Object.keys(body)
    .sort()
    .map((key) => `${key}${body[key] == null ? '' : String(body[key])}`)
    .join('');
  const validationStr = `${webhookUrl}${sortedParams}`;
  const expected = crypto.createHmac('sha1', token).update(validationStr, 'utf8').digest('base64');
  return timingSafeEqualStrings(String(header).trim(), expected);
}

async function loadClinicSmsConfig(clinicId) {
  if (!clinicId) return { twilioFrom: '', bookingUrl: '', slug: 'temara' };
  const result = await query(
    `SELECT slug, twilio_from, sms_booking_url, name
     FROM clinics WHERE id = $1 LIMIT 1`,
    [clinicId]
  );
  const row = result.rows[0] || {};
  return {
    slug: row.slug || 'temara',
    twilioFrom: String(row.twilio_from || '').trim(),
    bookingUrl: String(row.sms_booking_url || '').trim(),
    name: row.name || 'Clinique Dentaire Témara Mall',
  };
}

function clinicBookingUrl(clinic, req) {
  if (clinic?.bookingUrl) return clinic.bookingUrl;
  const base = publicBaseUrl(req);
  const slug = clinic?.slug || 'temara';
  return base ? `${base}/book/${slug}` : `https://cal.com/${slug}`;
}

async function sendTwilioSms({ to, body, from, statusCallback }) {
  const { accountSid, authToken, fromNumber } = twilioCredentials();
  if (!accountSid || !authToken) {
    return { ok: false, skipped: true, reason: 'twilio_not_configured', sid: null, error: 'Twilio not configured' };
  }
  const e164 = toE164MA(to);
  if (!isValidMaMobileE164(e164)) {
    return { ok: false, skipped: true, reason: 'invalid_phone', sid: null, error: 'invalid_phone', to: e164 };
  }
  const fromSms = String(from || fromNumber || '').trim();
  if (!fromSms) {
    return { ok: false, skipped: true, reason: 'twilio_from_missing', sid: null, error: 'Twilio from missing' };
  }

  const params = new URLSearchParams();
  params.set('To', e164);
  params.set('From', fromSms);
  params.set('Body', String(body || ''));
  if (statusCallback) params.set('StatusCallback', statusCallback);

  const response = await fetch(`${TWILIO_API}/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  const sid = payload.sid ? String(payload.sid) : '';
  if (!response.ok || !sid) {
    const error = payload.message || payload.error_message || `Twilio HTTP ${response.status}`;
    return { ok: false, skipped: false, reason: 'twilio_error', sid: null, error, to: e164 };
  }
  return { ok: true, skipped: false, reason: null, sid, to: e164, status: payload.status || 'queued' };
}

module.exports = {
  timingSafeEqualStrings,
  twilioCredentials,
  isTwilioConfigured,
  publicBaseUrl,
  twilioStatusCallbackUrl,
  canonicalTwilioUrl,
  verifyTwilioSignature,
  loadClinicSmsConfig,
  clinicBookingUrl,
  sendTwilioSms,
};
