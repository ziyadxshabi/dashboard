/**
 * DentaFlow OS — request validation, API errors, and clinic-scoped session gate.
 */
'use strict';

const { getTokenFromRequest, verifyJwt } = require('./auth-crypto');

const PHONE_RE = /^(\+212\s?|0)[5-7]\d{8}$/;
const NAME_RE = /^[a-zA-ZÀ-ÿ\s\-']+$/;

const BOOKING_STATUS_CODES = Object.freeze([
  'confirme',
  'en_attente',
  'en_salle',
  'en_soin',
  'termine',
  'no_show',
  'annule',
]);

const STATUS_CODE_TO_DB = Object.freeze({
  confirme: 'Confirme',
  en_attente: 'En attente',
  en_salle: "En salle d'attente",
  en_soin: 'En soin',
  termine: 'Termine',
  no_show: 'No-show',
  annule: 'Annule',
});

const STATUS_CODE_TO_UI = Object.freeze({
  confirme: 'Confirmé',
  en_attente: 'En attente',
  en_salle: "En salle d'attente",
  en_soin: 'En soin',
  termine: 'Terminé',
  no_show: 'No-show',
  annule: 'Annulé',
});

const APPOINTMENT_STATUSES = Object.freeze([
  'Confirmé',
  'Confirme',
  'En attente',
  "En salle d'attente",
  'En soin',
  'Terminé',
  'Termine',
  'No-show',
  'Annulé',
  'Annule',
  ...BOOKING_STATUS_CODES,
]);

const WAITLIST_PRIORITIES = Object.freeze(['Faible', 'Moyenne', 'Haute', 'Urgent']);

const ERROR_DEFAULTS = {
  UNAUTHORIZED: 'Unauthorized',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  VALIDATION_ERROR: 'Invalid input',
  METHOD_NOT_ALLOWED: 'Method Not Allowed',
  SERVER_ERROR: 'Internal server error',
};

function createApiError(code, message) {
  return {
    ok: false,
    error: message || ERROR_DEFAULTS[code] || code,
    code,
  };
}

function compactPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/[\s.\-]/g, '');
  if (compact.indexOf('+212') === 0) {
    return `+212${compact.slice(4)}`;
  }
  return compact;
}

function normalizeStatusKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u2019/g, "'");
}

function resolveBookingStatus(raw) {
  const key = normalizeStatusKey(raw)
    .replace(/['’]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_');
  if (!key) return null;

  const aliases = {
    confirme: 'confirme',
    en_attente: 'en_attente',
    en_salle: 'en_salle',
    en_salle_dattente: 'en_salle',
    en_salle_d_attente: 'en_salle',
    en_soin: 'en_soin',
    termine: 'termine',
    no_show: 'no_show',
    noshow: 'no_show',
    annule: 'annule',
  };

  const code = aliases[key];
  if (!code || !STATUS_CODE_TO_DB[code]) return null;

  return {
    code,
    dbStatus: STATUS_CODE_TO_DB[code],
    uiStatus: STATUS_CODE_TO_UI[code],
  };
}

function canonicalizeAppointmentStatus(raw) {
  const resolved = resolveBookingStatus(raw);
  return resolved ? resolved.uiStatus : null;
}

function isAllowedAppointmentStatus(raw) {
  return resolveBookingStatus(raw) != null;
}

function requireClinicSession(req, res, options = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(503).json(createApiError('SERVER_ERROR', 'Auth not configured'));
    return null;
  }

  const token = getTokenFromRequest(req);
  const payload = verifyJwt(token, secret);
  if (!payload) {
    res.status(401).json(createApiError('UNAUTHORIZED'));
    return null;
  }

  const allowedRoles = options.allowedRoles;
  if (Array.isArray(allowedRoles) && allowedRoles.length && !allowedRoles.includes(payload.role)) {
    res.status(403).json(createApiError('FORBIDDEN'));
    return null;
  }

  const clinicId = payload.clinic_id || payload.clinicId || process.env.CLINIC_ID || null;
  if (!clinicId) {
    res.status(401).json(createApiError('UNAUTHORIZED'));
    return null;
  }

  return { ...payload, clinic_id: clinicId };
}

function sendDbError(res, err) {
  if (err?.code === 'DB_NOT_CONFIGURED') {
    return res.status(503).json(createApiError('SERVER_ERROR', 'Database not configured'));
  }
  console.error('[db]', err?.message || err);
  return res.status(500).json(createApiError('SERVER_ERROR'));
}

function validateWaitlistInput(body = {}) {
  const patientName = String(
    body.patientName ?? body.patient_name ?? body.nom ?? body.name ?? ''
  ).trim();
  const phoneRaw = String(
    body.phone ?? body.patient_phone ?? body.telephone ?? ''
  ).trim();
  const phone = compactPhone(phoneRaw);
  const notes = String(body.notes ?? body.motif ?? body.reason ?? '').trim();

  let priority = String(
    body.urgency ?? body.priority ?? body.priorite ?? body.priorité ?? 'Moyenne'
  ).trim();
  if (/^urgent/i.test(priority)) priority = 'Urgent';
  if (/^(normale|moyenne)$/i.test(priority)) priority = 'Moyenne';
  if (/^(basse|faible)$/i.test(priority)) priority = 'Faible';
  if (/^haute$/i.test(priority)) priority = 'Haute';
  if (!WAITLIST_PRIORITIES.includes(priority)) priority = 'Moyenne';

  const errors = [];
  if (patientName.length < 2 || patientName.length > 100 || !NAME_RE.test(patientName)) {
    errors.push('patientName');
  }
  if (!PHONE_RE.test(phone)) {
    errors.push('phone');
  }

  if (errors.length) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'Nom et téléphone invalides'),
      fields: errors,
    };
  }

  return {
    ok: true,
    value: {
      patientName,
      phone,
      priority,
      notes,
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_TIME_RE = /^\d{2}:\d{2}$/;

function casablancaDateTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Casablanca',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

function validatePhone(value) {
  const phone = compactPhone(value);
  if (!PHONE_RE.test(phone)) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'Téléphone invalide'),
    };
  }
  return { ok: true, value: phone };
}

function sanitizeString(value, maxLen) {
  const limit = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 2000;
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!text) return '';
  return text.length > limit ? text.slice(0, limit) : text;
}

function parsePinned(value) {
  if (value === true || value === 1) return true;
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'oui' || raw === 'yes';
}

function validateTeamNoteInput(body = {}) {
  const note = sanitizeString(body.note ?? body.text ?? body.content ?? body.message, 2000);
  const patientName = sanitizeString(body.patientName ?? body.patient_name, 200);
  const bookingRaw = String(body.bookingId ?? body.booking_id ?? '').trim();
  const author = sanitizeString(body.author ?? body.author_name, 120);
  const category = sanitizeString(body.category, 64) || 'general';
  const pinned = parsePinned(body.pinned);

  if (!note) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'note is required'),
    };
  }

  return {
    ok: true,
    value: {
      note,
      patientName: patientName || null,
      bookingId: UUID_RE.test(bookingRaw) ? bookingRaw : null,
      author,
      category,
      pinned,
    },
  };
}

function validateFillGapInput(body = {}) {
  const defaults = casablancaDateTimeParts();
  const slotDate = String(body.slotDate ?? body.date ?? '').trim() || defaults.date;
  const slotTime = String(body.slotTime ?? body.time ?? '').trim() || defaults.time;
  const reason = String(body.reason ?? body.motif ?? '').trim();

  if (!SLOT_DATE_RE.test(slotDate)) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'slotDate must be YYYY-MM-DD'),
    };
  }
  if (!SLOT_TIME_RE.test(slotTime)) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'slotTime must be HH:MM'),
    };
  }
  if (reason.length > 500) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'reason is too long'),
    };
  }

  return {
    ok: true,
    value: { slotDate, slotTime, reason },
  };
}

function validatePasswordChange(body = {}) {
  const currentPassword = String(body.currentPassword ?? body.oldPassword ?? '');
  const newPassword = String(body.newPassword ?? '');

  if (!currentPassword) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'Le mot de passe actuel est requis'),
    };
  }

  if (!newPassword) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'Le nouveau mot de passe est requis'),
    };
  }

  if (newPassword.length < 8) {
    return {
      ok: false,
      error: createApiError(
        'VALIDATION_ERROR',
        'Le nouveau mot de passe doit contenir au moins 8 caractères'
      ),
    };
  }

  return {
    ok: true,
    value: { currentPassword, newPassword },
  };
}

function validateStatusUpdate(body = {}) {
  const bookingId = String(body.bookingId ?? body.id ?? body.cal_booking_uid ?? '').trim();
  const rawStatus = body.newStatus ?? body.status;
  const newStatus = String(rawStatus ?? '').trim();

  if (!bookingId) {
    return {
      ok: false,
      error: createApiError('VALIDATION_ERROR', 'bookingId is required'),
    };
  }

  const resolved = resolveBookingStatus(newStatus);
  if (!resolved) {
    return {
      ok: false,
      error: createApiError(
        'VALIDATION_ERROR',
        `newStatus must be one of: ${BOOKING_STATUS_CODES.join(', ')}`
      ),
    };
  }

  return {
    ok: true,
    value: {
      bookingId,
      newStatus: resolved.uiStatus,
      statusCode: resolved.code,
      dbStatus: resolved.dbStatus,
      uiStatus: resolved.uiStatus,
    },
  };
}

module.exports = {
  APPOINTMENT_STATUSES,
  BOOKING_STATUS_CODES,
  STATUS_CODE_TO_DB,
  STATUS_CODE_TO_UI,
  WAITLIST_PRIORITIES,
  createApiError,
  requireClinicSession,
  sendDbError,
  validateWaitlistInput,
  validatePasswordChange,
  validateStatusUpdate,
  validatePhone,
  sanitizeString,
  validateTeamNoteInput,
  validateFillGapInput,
  canonicalizeAppointmentStatus,
  resolveBookingStatus,
  compactPhone,
};
