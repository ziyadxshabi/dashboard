'use strict';

const { query } = require('./db');
const { displayNameUpper } = require('./phone-e164');
const { tryAcquireLock } = require('./notification-locks');
const {
  isTwilioConfigured,
  sendTwilioSms,
  twilioStatusCallbackUrl,
  loadClinicSmsConfig,
  clinicBookingUrl,
} = require('./twilio');
const templates = require('./sms-templates');

function resendConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || '').trim());
}

function slackConfigured() {
  return Boolean(String(process.env.SLACK_WEBHOOK_URL || '').trim());
}

async function sendSlack(text) {
  const url = String(process.env.SLACK_WEBHOOK_URL || '').trim();
  if (!url || !text) return { ok: false, skipped: true };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text) }),
    });
    return { ok: response.ok, skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}

async function sendResendEmail({ to, subject, html }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.RESEND_FROM || 'onboarding@resend.dev').trim();
  if (!apiKey || !to) return { ok: false, skipped: true };
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return { ok: response.ok, skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}

function brandedEmailHtml(title, bodyHtml, ctaLabel, ctaUrl) {
  const button = ctaUrl
    ? `<p><a href="${ctaUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${ctaLabel || 'Ouvrir'}</a></p>`
    : '';
  return `<div style="font-family:Georgia,serif;background:#111;color:#f5f0e8;padding:24px">
    <h1 style="font-size:18px">${title}</h1>
    <div>${bodyHtml}</div>
    ${button}
    <p style="opacity:.7;font-size:12px">Clinique Dentaire Témara Mall</p>
  </div>`;
}

async function persistSmsRow({
  clinicId,
  bookingId,
  waitlistId,
  purpose,
  toPhone,
  body,
  sid,
  status,
  error,
}) {
  const result = await query(
    `INSERT INTO sms_messages (
       clinic_id, booking_id, waitlist_id, purpose, to_phone, body,
       twilio_sid, status, error, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     RETURNING id, twilio_sid, status`,
    [
      clinicId || null,
      bookingId || null,
      waitlistId || null,
      purpose,
      toPhone,
      body,
      sid || null,
      status || (sid ? 'queued' : 'failed'),
      error || null,
    ]
  );
  if (bookingId && sid) {
    await query(
      `UPDATE bookings
       SET sms_status = $1, sms_last_sid = $2, sms_last_error = NULL, updated_at = NOW()
       WHERE id = $3`,
      [status || 'queued', sid, bookingId]
    );
  } else if (bookingId && error) {
    await query(
      `UPDATE bookings
       SET sms_status = 'failed', sms_last_error = $1, updated_at = NOW()
       WHERE id = $2`,
      [String(error).slice(0, 500), bookingId]
    );
  }
  return result.rows[0] || null;
}

async function dispatchSms({
  clinicId,
  bookingId,
  waitlistId,
  purpose,
  to,
  body,
  from,
  req,
  lockKey,
  lockTtlSec,
}) {
  if (lockKey) {
    const lock = await tryAcquireLock(lockKey, lockTtlSec);
    if (lock.error || (!lock.acquired && lock.duplicate)) {
      return {
        ok: false,
        skipped: true,
        reason: lock.duplicate ? 'duplicate' : 'lock_error',
        sid: null,
      };
    }
  }

  if (!isTwilioConfigured()) {
    return { ok: false, skipped: true, reason: 'twilio_not_configured', sid: null };
  }

  const clinic = await loadClinicSmsConfig(clinicId);
  const sent = await sendTwilioSms({
    to,
    body,
    from: from || clinic.twilioFrom,
    statusCallback: twilioStatusCallbackUrl(req),
  });

  if (sent.ok && sent.sid) {
    await persistSmsRow({
      clinicId,
      bookingId,
      waitlistId,
      purpose,
      toPhone: sent.to,
      body,
      sid: sent.sid,
      status: sent.status || 'queued',
    });
    return { ok: true, skipped: false, sid: sent.sid, to: sent.to };
  }

  if (!sent.skipped) {
    try {
      await persistSmsRow({
        clinicId,
        bookingId,
        waitlistId,
        purpose,
        toPhone: sent.to || String(to || ''),
        body,
        sid: null,
        status: 'failed',
        error: sent.error,
      });
    } catch {
      // fail-open
    }
  }

  return {
    ok: false,
    skipped: Boolean(sent.skipped),
    reason: sent.reason,
    sid: null,
    error: sent.error,
    to: sent.to,
  };
}

async function notifyBookingCreated(booking, req) {
  const name = displayNameUpper(booking.patient_name);
  const sms = await dispatchSms({
    clinicId: booking.clinic_id,
    bookingId: booking.id,
    purpose: 'confirm',
    to: booking.patient_phone,
    body: templates.confirmSms(name),
    req,
    lockKey: `sms:confirm:${booking.id}`,
  });
  if (sms.ok) {
    await sendSlack(templates.SLACK.created(name));
  } else if (!sms.skipped) {
    await sendSlack(templates.SLACK.smsFailed(name));
  }
  if (booking.patient_email && resendConfigured()) {
    const clinic = await loadClinicSmsConfig(booking.clinic_id);
    const url = clinicBookingUrl(clinic, req);
    await sendResendEmail({
      to: booking.patient_email,
      subject: templates.confirmEmailSubject(name),
      html: brandedEmailHtml(
        'Confirmation',
        `<p>Votre rendez-vous est confirmé.</p><p>Date &amp; Heure : ${booking.starts_at}</p>`,
        'Gérer mon rendez-vous →',
        url
      ),
    });
  }
  return sms;
}

async function notifyBookingRescheduled(booking, req) {
  const name = displayNameUpper(booking.patient_name);
  const sms = await dispatchSms({
    clinicId: booking.clinic_id,
    bookingId: booking.id,
    purpose: 'reschedule',
    to: booking.patient_phone,
    body: templates.rescheduleSms(name),
    req,
    lockKey: `sms:reschedule:${booking.id}:${booking.starts_at}`,
  });
  await sendSlack(templates.SLACK.rescheduled(name, booking.starts_at));
  if (booking.patient_email && resendConfigured()) {
    const clinic = await loadClinicSmsConfig(booking.clinic_id);
    const url = clinicBookingUrl(clinic, req);
    await sendResendEmail({
      to: booking.patient_email,
      subject: templates.rescheduleEmailSubject(name),
      html: brandedEmailHtml(
        'Rendez-vous modifié',
        `<p>Nouveau créneau : ${booking.starts_at}</p>`,
        'Gérer mon rendez-vous →',
        url
      ),
    });
  }
  return sms;
}

async function notifyBookingCancelled(booking, req) {
  const name = displayNameUpper(booking.patient_name);
  await sendSlack(templates.SLACK.cancelled(name));
  if (booking.patient_email && resendConfigured()) {
    const clinic = await loadClinicSmsConfig(booking.clinic_id);
    const url = clinicBookingUrl(clinic, req);
    await sendResendEmail({
      to: booking.patient_email,
      subject: templates.cancelEmailSubject(name),
      html: brandedEmailHtml(
        'Rendez-vous annulé',
        `<p>Annulation pour ${booking.starts_at}</p>`,
        'Prendre un nouveau RDV →',
        url
      ),
    });
  }
}

async function updateSmsStatusBySid(messageSid, messageStatus) {
  const sid = String(messageSid || '').trim();
  const status = String(messageStatus || 'unknown').trim();
  if (!sid) return null;
  const result = await query(
    `UPDATE sms_messages
     SET status = $1, updated_at = NOW()
     WHERE twilio_sid = $2
     RETURNING id, booking_id, clinic_id`,
    [status, sid]
  );
  const row = result.rows[0];
  if (row?.booking_id) {
    await query(
      `UPDATE bookings SET sms_status = $1, updated_at = NOW() WHERE id = $2`,
      [status, row.booking_id]
    );
  }
  return row || null;
}

module.exports = {
  resendConfigured,
  slackConfigured,
  sendSlack,
  sendResendEmail,
  brandedEmailHtml,
  persistSmsRow,
  dispatchSms,
  notifyBookingCreated,
  notifyBookingRescheduled,
  notifyBookingCancelled,
  updateSmsStatusBySid,
  displayNameUpper,
};
