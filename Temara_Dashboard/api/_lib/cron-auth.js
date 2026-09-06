'use strict';

const crypto = require('crypto');
const { extractBearerToken } = require('./auth-crypto');
const { createApiError } = require('./validation');

function timingSafeEqualStrings(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cronSecret() {
  return String(process.env.CRON_SECRET || '').trim();
}

function hasValidCronSecret(req) {
  const expected = cronSecret();
  if (!expected) return false;
  const bearer = extractBearerToken(req);
  const header = String(req.headers['x-cron-secret'] || '').trim();
  return timingSafeEqualStrings(bearer, expected) || timingSafeEqualStrings(header, expected);
}

function requireCronOrStaff(req, res, requireClinicSession) {
  if (hasValidCronSecret(req)) {
    return { type: 'cron', clinic_id: null, role: 'cron' };
  }
  return requireClinicSession(req, res, { allowedRoles: ['doctor', 'assistant'] });
}

function cronUnauthorized(res) {
  return res.status(401).json(createApiError('UNAUTHORIZED', 'Cron secret required'));
}

module.exports = {
  cronSecret,
  hasValidCronSecret,
  requireCronOrStaff,
  cronUnauthorized,
};
