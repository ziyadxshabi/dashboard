'use strict';

function toE164MA(raw) {
  if (raw == null || raw === '') return '';
  let phone = String(raw).replace(/[\s\-().]/g, '');
  if (!phone) return '';
  if (phone.startsWith('+')) return phone;
  if (phone.startsWith('00')) return `+${phone.slice(2)}`;
  if (phone.startsWith('212')) return `+${phone}`;
  if (phone.startsWith('0')) return `+212${phone.slice(1)}`;
  return `+212${phone}`;
}

function isValidMaMobileE164(e164) {
  return /^\+212[5-7]\d{8}$/.test(String(e164 || ''));
}

function displayNameUpper(name) {
  const text = String(name || '').trim();
  return text ? text.toUpperCase() : 'PATIENT';
}

module.exports = {
  toE164MA,
  isValidMaMobileE164,
  displayNameUpper,
};
