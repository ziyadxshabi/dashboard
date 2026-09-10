'use strict';

const { query } = require('./db');
const { toE164MA, isValidMaMobileE164, displayNameUpper } = require('./phone-e164');
const { tryAcquireLock } = require('./notification-locks');
const { dispatchSms, sendSlack } = require('./notify');
const { loadClinicSmsConfig, clinicBookingUrl } = require('./twilio');
const { waitlistSms, slotFilledCleanupSms, SLACK } = require('./sms-templates');

const PRIORITY_RANK = {
  Urgent: 0,
  urgent: 0,
  Haute: 1,
  haute: 1,
  Moyenne: 2,
  moyenne: 2,
  Normale: 2,
  normale: 2,
  Faible: 3,
  faible: 3,
  Basse: 3,
  basse: 3,
};

function waitlistRank(priority) {
  const key = String(priority || '').trim();
  if (Object.prototype.hasOwnProperty.call(PRIORITY_RANK, key)) return PRIORITY_RANK[key];
  const lower = key.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PRIORITY_RANK, lower)) return PRIORITY_RANK[lower];
  return 3;
}

function pickWaitlistTopN(rows, n = 3) {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a, b) => {
    const rank = waitlistRank(a.priority) - waitlistRank(b.priority);
    if (rank) return rank;
    const aTime = new Date(a.created_at || 0).getTime();
    const bTime = new Date(b.created_at || 0).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return String(a.id).localeCompare(String(b.id));
  });
  return list.slice(0, Math.max(1, n));
}

async function loadActiveWaitlist(clinicId) {
  const result = await query(
    `SELECT id, patient_name, patient_phone, priority::text AS priority,
            sms_consent, last_notified_at, created_at
     FROM waitlist
     WHERE clinic_id = $1 AND status = 'active'`,
    [clinicId]
  );
  return result.rows || [];
}

async function blastWaitlistSlot(clinicId, req, options = {}) {
  const topN = options.topN == null ? 3 : options.topN;
  const excludeIds = new Set((options.excludeIds || []).map(String));
  const batchId = options.batchId || `wl-${Date.now()}`;
  if (options.batchId) {
    const blastLock = await tryAcquireLock(`waitlist:blast:${batchId}`, 86400);
    if (blastLock.duplicate) {
      return {
        ok: true,
        batchId,
        notified: [],
        skipped: [{ reason: 'already_notified' }],
        duplicate: true,
        bookingUrl: '',
      };
    }
  }
  const clinic = await loadClinicSmsConfig(clinicId);
  const url = clinicBookingUrl(clinic, req);
  const rows = (await loadActiveWaitlist(clinicId)).filter((row) => !excludeIds.has(String(row.id)));
  const top = pickWaitlistTopN(rows, topN);
  const notified = [];
  const skipped = [];

  for (const row of top) {
    if (row.sms_consent !== true) {
      skipped.push({ id: row.id, reason: 'no_consent' });
      continue;
    }
    const e164 = toE164MA(row.patient_phone);
    if (!isValidMaMobileE164(e164)) {
      skipped.push({ id: row.id, reason: 'invalid_phone' });
      await sendSlack(SLACK.badPhone(row.patient_phone));
      continue;
    }
    const lock = await tryAcquireLock(`waitlist:notified:${e164}`, 86400);
    if (lock.error) {
      skipped.push({ id: row.id, reason: 'lock_error' });
      continue;
    }
    if (lock.duplicate) {
      skipped.push({ id: row.id, reason: 'already_notified' });
      continue;
    }
    const name = displayNameUpper(row.patient_name);
    const sms = await dispatchSms({
      clinicId,
      waitlistId: row.id,
      purpose: 'waitlist',
      to: e164,
      body: waitlistSms(name, url),
      req,
    });
    if (sms.ok && sms.sid) {
      await query(
        `UPDATE waitlist
         SET last_notified_at = NOW(), last_notified_batch = $2
         WHERE id = $1`,
        [row.id, batchId]
      );
      notified.push({ id: row.id, sid: sms.sid, to: sms.to });
    } else {
      skipped.push({ id: row.id, reason: sms.reason || 'send_failed' });
    }
  }

  return { ok: true, batchId, notified, skipped, bookingUrl: url };
}

async function notifySlotFilledCleanup(clinicId, req, bookedWaitlistId) {
  const clinic = await loadClinicSmsConfig(clinicId);
  const url = clinicBookingUrl(clinic, req);
  const result = await query(
    `SELECT id, patient_phone
     FROM waitlist
     WHERE clinic_id = $1
       AND status = 'active'
       AND last_notified_at > NOW() - INTERVAL '24 hours'
       AND ($2::uuid IS NULL OR id <> $2)
     ORDER BY last_notified_at DESC
     LIMIT 2`,
    [clinicId, bookedWaitlistId || null]
  );
  const sent = [];
  for (const row of result.rows || []) {
    const sms = await dispatchSms({
      clinicId,
      waitlistId: row.id,
      purpose: 'slot_filled_cleanup',
      to: row.patient_phone,
      body: slotFilledCleanupSms(url),
      req,
      lockKey: `sms:cleanup:${row.id}`,
    });
    if (sms.ok) sent.push({ id: row.id, sid: sms.sid });
  }
  return sent;
}

module.exports = {
  waitlistRank,
  pickWaitlistTopN,
  loadActiveWaitlist,
  blastWaitlistSlot,
  notifySlotFilledCleanup,
};
