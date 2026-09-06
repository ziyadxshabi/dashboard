/**
 * Shared booking math for dashboard KPIs, roster windows, gaps, and directory.
 * Clinic local time is Africa/Casablanca. Hours match FullCalendar 08:00–19:00.
 */
'use strict';

const { compactPhone, STATUS_CODE_TO_DB } = require('./validation');

const TIMEZONE = 'Africa/Casablanca';
const CLINIC_OPEN_HOUR = 8;
const CLINIC_CLOSE_HOUR = 19;
const CLINIC_OPEN_MIN = CLINIC_OPEN_HOUR * 60;
const CLINIC_CLOSE_MIN = CLINIC_CLOSE_HOUR * 60;
const CLINIC_MINUTES_PER_DAY = CLINIC_CLOSE_MIN - CLINIC_OPEN_MIN;
const MIN_GAP_MINUTES = 30;
const RANGE_MAX_DAYS = 92;
const HOUR_START = 8;
const HOUR_END = 18;
const DIRECTORY_BOOKING_LIMIT = 8000;
const RECENT_VISITS_LIMIT = 20;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS = Object.freeze({
  confirme: STATUS_CODE_TO_DB.confirme,
  enAttente: STATUS_CODE_TO_DB.en_attente,
  enSalle: STATUS_CODE_TO_DB.en_salle,
  enSoin: STATUS_CODE_TO_DB.en_soin,
  termine: STATUS_CODE_TO_DB.termine,
  noShow: STATUS_CODE_TO_DB.no_show,
  annule: STATUS_CODE_TO_DB.annule,
});

const DATE_SQL = `(starts_at AT TIME ZONE '${TIMEZONE}')::date`;
const HOUR_SQL = `EXTRACT(HOUR FROM (starts_at AT TIME ZONE '${TIMEZONE}'))::int`;

const PHONE_KEY_SQL = `
  CASE
    WHEN regexp_replace(COALESCE(patient_phone, ''), '[^0-9]', '', 'g') LIKE '212%'
      THEN '+212' || substr(regexp_replace(patient_phone, '[^0-9]', '', 'g'), 4)
    WHEN regexp_replace(COALESCE(patient_phone, ''), '[^0-9]', '', 'g') LIKE '0%'
      THEN '+212' || substr(regexp_replace(patient_phone, '[^0-9]', '', 'g'), 2)
    WHEN length(regexp_replace(COALESCE(patient_phone, ''), '[^0-9]', '', 'g')) = 9
      THEN '+212' || regexp_replace(patient_phone, '[^0-9]', '', 'g')
    ELSE regexp_replace(COALESCE(patient_phone, ''), '[^0-9]', '', 'g')
  END
`;

function casablancaYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function addDaysYmd(ymd, days) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day + Number(days || 0));
  const next = new Date(utc);
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${next.getUTCFullYear()}-${mm}-${dd}`;
}

function inclusiveDayCount(fromYmd, toYmd) {
  const from = Date.parse(`${fromYmd}T00:00:00Z`);
  const to = Date.parse(`${toYmd}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.round((to - from) / 86400000) + 1;
}

function parseIsoDate(raw) {
  const value = String(raw || '').trim();
  if (!ISO_DATE_RE.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return value;
}

function parsePeriod(raw) {
  const key = String(raw || 'today').trim().toLowerCase();
  if (key === 'week' || key === 'month' || key === 'today') return key;
  return null;
}

function periodRange(period, now = new Date()) {
  const today = casablancaYmd(now);
  if (period === 'week') {
    return { from: addDaysYmd(today, -6), to: today, period: 'week' };
  }
  if (period === 'month') {
    return { from: addDaysYmd(today, -29), to: today, period: 'month' };
  }
  return { from: today, to: today, period: 'today' };
}

function validateDateRange(fromRaw, toRaw) {
  const from = parseIsoDate(fromRaw);
  const to = parseIsoDate(toRaw);
  if (!from || !to) {
    return { ok: false, error: 'from and to must be YYYY-MM-DD' };
  }
  if (to < from) {
    return { ok: false, error: 'to must be on or after from' };
  }
  const days = inclusiveDayCount(from, to);
  if (days > RANGE_MAX_DAYS) {
    return { ok: false, error: `Date range cannot exceed ${RANGE_MAX_DAYS} days` };
  }
  return { ok: true, from, to, days };
}

function occupancyCapacityMin(fromYmd, toYmd) {
  return inclusiveDayCount(fromYmd, toYmd) * CLINIC_MINUTES_PER_DAY;
}

function occupancyPct(bookedMin, capacityMin) {
  const booked = Math.max(0, Number(bookedMin) || 0);
  const capacity = Math.max(0, Number(capacityMin) || 0);
  if (!capacity) return 0;
  return Math.round((booked / capacity) * 1000) / 10;
}

function emptyHours() {
  const hours = {};
  for (let hour = HOUR_START; hour <= HOUR_END; hour += 1) {
    hours[String(hour).padStart(2, '0')] = 0;
  }
  return hours;
}

function hoursFromRows(rows) {
  const hours = emptyHours();
  for (const row of rows || []) {
    const hour = Number(row.hour);
    if (!Number.isInteger(hour) || hour < HOUR_START || hour > HOUR_END) continue;
    hours[String(hour).padStart(2, '0')] = Number(row.n) || 0;
  }
  return hours;
}

function flattenHourKeys(hours) {
  const out = {};
  for (let hour = HOUR_START; hour <= HOUR_END; hour += 1) {
    const key = String(hour).padStart(2, '0');
    out[`hour_${key}`] = Number(hours?.[key]) || 0;
  }
  return out;
}

function noShowRate(noShows, completed) {
  const missed = Math.max(0, Number(noShows) || 0);
  const seen = Math.max(0, Number(completed) || 0);
  const denom = missed + seen;
  if (!denom) return null;
  return Math.round((missed / denom) * 1000) / 10;
}

function normalizePhoneKey(value) {
  const compact = compactPhone(value);
  if (!compact) return '';
  const digits = compact.replace(/\D/g, '');
  if (digits.startsWith('212') && digits.length >= 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length >= 10) return `+212${digits.slice(1)}`;
  if (digits.length === 9 && /^[5-7]/.test(digits)) return `+212${digits}`;
  if (compact.startsWith('+')) return compact;
  return digits ? `+${digits}` : '';
}

function casablancaHm(startsAt) {
  if (startsAt == null || startsAt === '') return '';
  const parsed = startsAt instanceof Date ? startsAt : new Date(startsAt);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIMEZONE,
  });
}

function minutesOnClinicDay(startsAt) {
  const hm = casablancaHm(startsAt);
  const match = hm.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinutes(total) {
  const clamped = Math.max(0, Number(total) || 0);
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function occupiesChair(status) {
  return String(status || '') !== STATUS.annule;
}

function computeGaps(bookings, dateYmd) {
  const intervals = [];
  for (const row of bookings || []) {
    if (!occupiesChair(row.status)) continue;
    const start = minutesOnClinicDay(row.starts_at);
    if (start == null) continue;
    const duration = Math.max(1, Number(row.duration_min) || 30);
    intervals.push({
      start: Math.max(CLINIC_OPEN_MIN, start),
      end: Math.min(CLINIC_CLOSE_MIN, start + duration),
    });
  }

  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of intervals) {
    if (interval.end <= interval.start) continue;
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
    } else {
      last.end = Math.max(last.end, interval.end);
    }
  }

  const gaps = [];
  let cursor = CLINIC_OPEN_MIN;
  for (const block of merged) {
    if (block.start - cursor >= MIN_GAP_MINUTES) {
      gaps.push({
        date: dateYmd,
        start: formatMinutes(cursor),
        end: formatMinutes(block.start),
        duration_min: block.start - cursor,
      });
    }
    cursor = Math.max(cursor, block.end);
  }
  if (CLINIC_CLOSE_MIN - cursor >= MIN_GAP_MINUTES) {
    gaps.push({
      date: dateYmd,
      start: formatMinutes(cursor),
      end: formatMinutes(CLINIC_CLOSE_MIN),
      duration_min: CLINIC_CLOSE_MIN - cursor,
    });
  }
  return gaps;
}

function mapBookingRow(row) {
  const patientName = row.patient_name || '';
  const patientPhone = row.patient_phone || '';
  const treatmentName = row.treatment_name || '';
  const time = casablancaHm(row.starts_at);
  const email = row.patient_email || '';

  return {
    id: row.id,
    name: patientName,
    patient_name: patientName,
    phone: patientPhone,
    patient_phone: patientPhone,
    patient_email: email,
    email,
    treatment_name: treatmentName,
    treatment: treatmentName,
    status: row.status,
    time,
    duration_min: row.duration_min,
    cal_booking_uid: row.cal_booking_uid,
    calBookingId: row.cal_booking_uid,
    notes: row.notes || '',
    starts_at: row.starts_at,
    startTime: row.starts_at,
  };
}

function groupDirectory(rows) {
  const groups = new Map();
  const now = Date.now();

  for (const row of rows || []) {
    const phoneKey = normalizePhoneKey(row.patient_phone) || String(row.patient_phone || '').trim();
    if (!phoneKey) continue;
    let group = groups.get(phoneKey);
    if (!group) {
      group = {
        id: phoneKey,
        phone: row.patient_phone || '',
        phone_e164: phoneKey,
        name: row.patient_name || '',
        email: row.patient_email || '',
        visit_count: 0,
        last_visit: null,
        next_visit: null,
        last_treatment: row.treatment_name || '',
        no_show_count: 0,
        cancel_count: 0,
        recent_visits: [],
      };
      groups.set(phoneKey, group);
    }

    group.visit_count += 1;
    if (row.patient_phone) group.phone = row.patient_phone;
    if (row.patient_email) group.email = row.patient_email;
    if (String(row.status) === STATUS.noShow) group.no_show_count += 1;
    if (String(row.status) === STATUS.annule) group.cancel_count += 1;

    const startMs = row.starts_at ? new Date(row.starts_at).getTime() : NaN;
    if (Number.isFinite(startMs)) {
      if (startMs <= now) {
        if (!group.last_visit || startMs > new Date(group.last_visit).getTime()) {
          group.last_visit = row.starts_at;
          if (row.treatment_name) group.last_treatment = row.treatment_name;
          if (row.patient_name) group.name = row.patient_name;
        }
      } else if (String(row.status) !== STATUS.annule) {
        if (!group.next_visit || startMs < new Date(group.next_visit).getTime()) {
          group.next_visit = row.starts_at;
        }
      }
    }

    if (group.recent_visits.length < RECENT_VISITS_LIMIT) {
      group.recent_visits.push({
        id: row.id,
        starts_at: row.starts_at,
        treatment_name: row.treatment_name || '',
        status: row.status,
        notes: row.notes || '',
        duration_min: row.duration_min,
        patient_email: row.patient_email || '',
      });
    }
  }

  return Array.from(groups.values()).sort((a, b) => {
    const aTime = a.last_visit ? new Date(a.last_visit).getTime() : 0;
    const bTime = b.last_visit ? new Date(b.last_visit).getTime() : 0;
    return bTime - aTime;
  });
}

function searchParamsFromReq(req) {
  try {
    return new URL(String(req.url || ''), 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

module.exports = {
  TIMEZONE,
  CLINIC_OPEN_HOUR,
  CLINIC_CLOSE_HOUR,
  CLINIC_MINUTES_PER_DAY,
  MIN_GAP_MINUTES,
  RANGE_MAX_DAYS,
  HOUR_START,
  HOUR_END,
  DIRECTORY_BOOKING_LIMIT,
  RECENT_VISITS_LIMIT,
  STATUS,
  DATE_SQL,
  HOUR_SQL,
  PHONE_KEY_SQL,
  casablancaYmd,
  addDaysYmd,
  inclusiveDayCount,
  parseIsoDate,
  parsePeriod,
  periodRange,
  validateDateRange,
  occupancyCapacityMin,
  occupancyPct,
  emptyHours,
  hoursFromRows,
  flattenHourKeys,
  noShowRate,
  normalizePhoneKey,
  casablancaHm,
  computeGaps,
  mapBookingRow,
  groupDirectory,
  searchParamsFromReq,
};
