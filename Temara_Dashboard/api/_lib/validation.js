/**
 * DentaFlow OS — request validation, API errors, and clinic-scoped session gate.
 */
'use strict';

const { getTokenFromRequest, verifyJwt } = require('./auth-crypto');

const PHONE_RE = /^(\+212\s?|0)[5-7]\d{8}$/;
const NAME_RE = /^[a-zA-ZÀ-ÿ\s\-']+$/;

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
]);

const WAITLIST_PRIORITIES = Object.freeze(['Haute', 'Normale', 'Basse', 'Urgent']);

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

function canonicalizeAppointmentStatus(raw) {
  const key = normalizeStatusKey(raw);
  if (!key) return null;

  const aliases = {
    confirme: 'Confirmé',
    'en attente': 'En attente',
    "en salle d'attente": "En salle d'attente",
    'en salle dattente': "En salle d'attente",
    'en soin': 'En soin',
    termine: 'Terminé',
    'no-show': 'No-show',
    noshow: 'No-show',
    annule: 'Annulé',
  };

  return aliases[key] || null;
}

function isAllowedAppointmentStatus(raw) {
  const value = String(raw || '').trim();
  if (APPOINTMENT_STATUSES.includes(value)) return true;
  return canonicalizeAppointmentStatus(value) != null;
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
    body.urgency ?? body.priority ?? body.priorite ?? body.priorité ?? 'Normale'
  ).trim();
  if (/^urgent/i.test(priority)) priority = 'Urgent';
  if (!WAITLIST_PRIORITIES.includes(priority)) priority = 'Normale';

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

  if (!isAllowedAppointmentStatus(newStatus)) {
    return {
      ok: false,
      error: createApiError(
        'VALIDATION_ERROR',
        `newStatus must be one of: ${APPOINTMENT_STATUSES.join(', ')}`
      ),
    };
  }

  return {
    ok: true,
    value: {
      bookingId,
      newStatus,
    },
  };
}

module.exports = {
  APPOINTMENT_STATUSES,
  WAITLIST_PRIORITIES,
  createApiError,
  requireClinicSession,
  sendDbError,
  validateWaitlistInput,
  validateStatusUpdate,
  canonicalizeAppointmentStatus,
  compactPhone,
};
