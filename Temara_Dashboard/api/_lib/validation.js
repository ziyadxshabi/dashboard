/**
 * Shared input validation and sanitization for DentaFlow API routes.
 * Zero dependencies. CommonJS exports only.
 */

const ALLOWED_STATUSES = [
  'Confirmé',
  'En attente',
  "En salle d'attente",
  'En soin',
  'Terminé',
  'No-show',
  'Annulé',
];

const STATUS_LOOKUP = new Map(
  ALLOWED_STATUSES.map((label) => [label.toLowerCase(), label])
);

const HTML_TAG_RE = /<\/?[^>]+>/g;
const UNSAFE_CHARS_RE = /[<>&"']/g;
const DATE_YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MA_LOCAL_RE = /^0[5-7]\d{8}$/;
const MA_E164_RE = /^\+212[5-7]\d{8}$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;

function sanitizeString(str, maxLength = 255) {
  if (typeof str !== 'string') return '';

  const limit = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 255;
  const cleaned = str
    .replace(HTML_TAG_RE, '')
    .replace(UNSAFE_CHARS_RE, '')
    .trim();

  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned;
}

function isNonEmptyValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return String(value).trim().length > 0;
}

function validateRequired(obj, fields) {
  const source = obj && typeof obj === 'object' ? obj : {};
  const keys = Array.isArray(fields) ? fields : [];
  const missing = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(source, key) || !isNonEmptyValue(source[key])) {
      missing.push(String(key));
    }
  }

  if (missing.length) {
    return { valid: false, missing };
  }
  return { valid: true };
}

function validateStatus(status) {
  if (typeof status !== 'string' || !status.trim()) {
    return { valid: false, error: 'Status is required' };
  }

  const normalized = STATUS_LOOKUP.get(status.trim().toLowerCase());
  if (!normalized) {
    return { valid: false, error: 'Invalid appointment status' };
  }
  return { valid: true, normalized };
}

function compactPhone(phone) {
  if (typeof phone !== 'string') return '';
  return phone.trim().replace(/[\s.\-]/g, '');
}

function validatePhone(phone) {
  const compact = compactPhone(phone);
  if (!compact) {
    return { valid: false, error: 'Phone number is required' };
  }

  if (MA_LOCAL_RE.test(compact)) {
    return { valid: true, normalized: `+212${compact.slice(1)}` };
  }
  if (MA_E164_RE.test(compact)) {
    return { valid: true, normalized: compact };
  }
  if (E164_RE.test(compact)) {
    return { valid: true, normalized: compact };
  }

  return { valid: false, error: 'Invalid phone number' };
}

function calendarDateIsReal(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function validateDate(dateStr) {
  if (typeof dateStr !== 'string' || !dateStr.trim()) {
    return { valid: false, error: 'Date is required' };
  }

  const trimmed = dateStr.trim();
  const ymd = trimmed.match(DATE_YMD_RE);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    if (!calendarDateIsReal(year, month, day)) {
      return { valid: false, error: 'Invalid calendar date' };
    }
    return {
      valid: true,
      date: new Date(Date.UTC(year, month - 1, day)),
      formatted: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    };
  }

  const iso = trimmed.match(DATE_ISO_RE);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!calendarDateIsReal(year, month, day)) {
      return { valid: false, error: 'Invalid calendar date' };
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return { valid: false, error: 'Invalid ISO timestamp' };
    }
    return { valid: true, date: parsed, formatted: parsed.toISOString() };
  }

  return { valid: false, error: 'Invalid date format' };
}

function validateTime(timeStr) {
  if (typeof timeStr !== 'string' || !timeStr.trim()) {
    return { valid: false, error: 'Time is required' };
  }

  const trimmed = timeStr.trim();
  if (!TIME_RE.test(trimmed)) {
    return { valid: false, error: 'Invalid time format' };
  }
  return { valid: true, formatted: trimmed };
}

function createApiError(code, message, details = null) {
  return {
    ok: false,
    error: message,
    code,
    details,
  };
}

module.exports = {
  sanitizeString,
  validateRequired,
  validateStatus,
  validatePhone,
  validateDate,
  validateTime,
  createApiError,
};
