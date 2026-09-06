'use strict';

const { query } = require('./db');

function calApiKey() {
  return String(process.env.CALCOM_API_KEY || '').trim();
}

function calConfigured() {
  return Boolean(calApiKey());
}

async function loadClinicCal(clinicId) {
  const result = await query(
    `SELECT slug, cal_event_type_id, name FROM clinics WHERE id = $1 LIMIT 1`,
    [clinicId]
  );
  return result.rows[0] || null;
}

function isoFrom(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function createCalBusyBooking({ clinicId, startsAt, durationMin, label, kind }) {
  const apiKey = calApiKey();
  if (!apiKey) return { ok: false, skipped: true, reason: 'cal_api_not_configured' };

  const clinic = await loadClinicCal(clinicId);
  const eventTypeId = Number(clinic?.cal_event_type_id);
  if (!Number.isFinite(eventTypeId) || eventTypeId <= 0) {
    return { ok: false, skipped: true, reason: 'cal_event_type_missing' };
  }

  const start = isoFrom(startsAt);
  if (!start) return { ok: false, skipped: true, reason: 'invalid_start' };
  const minutes = Math.max(1, Number(durationMin) || 30);
  const end = new Date(new Date(start).getTime() + minutes * 60000).toISOString();
  const email = String(process.env.CLINIC_URGENCY_EMAIL || process.env.RESEND_FROM || '').trim();
  if (!email) return { ok: false, skipped: true, reason: 'cal_block_email_missing' };

  const name = kind === 'emergency_hold' ? 'Urgence DentaFlow' : label || 'Indisponible DentaFlow';
  try {
    const response = await fetch('https://api.cal.com/v1/bookings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventTypeId,
        start,
        end,
        responses: {
          name,
          email,
          notes: 'Créneau bloqué automatiquement via DentaFlow OS — Superpouvoir',
        },
        metadata: {
          source: 'dentaflow-superpouvoir-block-slot',
          clinic_id: clinicId,
          kind,
        },
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const uid = payload?.uid || payload?.id || payload?.booking?.uid;
    if (!response.ok || !uid) {
      return { ok: false, skipped: false, reason: 'cal_api_error', error: payload?.message || `HTTP ${response.status}` };
    }
    return { ok: true, skipped: false, uid: String(uid) };
  } catch (err) {
    return { ok: false, skipped: false, reason: 'cal_api_error', error: err?.message || String(err) };
  }
}

async function cancelCalBusyBooking(uid) {
  const apiKey = calApiKey();
  const bookingUid = String(uid || '').trim();
  if (!apiKey || !bookingUid) return { ok: false, skipped: true };
  try {
    const response = await fetch(
      `https://api.cal.com/v1/bookings/${encodeURIComponent(bookingUid)}/cancel?apiKey=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cancellationReason: 'DentaFlow block released' }),
      }
    );
    return { ok: response.ok, skipped: false };
  } catch {
    return { ok: false, skipped: false };
  }
}

async function attachCalUid(bookingId, uid) {
  if (!bookingId || !uid) return;
  await query(
    `UPDATE bookings SET cal_booking_uid = COALESCE(cal_booking_uid, $1), updated_at = NOW() WHERE id = $2`,
    [String(uid), bookingId]
  );
}

module.exports = {
  calConfigured,
  createCalBusyBooking,
  cancelCalBusyBooking,
  attachCalUid,
};
