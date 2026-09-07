'use strict';

const crypto = require('crypto');
const { query } = require('./db');

function newConfirmToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function attachConfirmToken(bookingId) {
  if (!bookingId) return null;
  const existing = await query(
    `SELECT confirm_token FROM bookings WHERE id = $1 LIMIT 1`,
    [bookingId]
  );
  if (existing.rows[0]?.confirm_token) return existing.rows[0].confirm_token;
  const token = newConfirmToken();
  const updated = await query(
    `UPDATE bookings
     SET confirm_token = COALESCE(confirm_token, $2), updated_at = NOW()
     WHERE id = $1
     RETURNING confirm_token`,
    [bookingId, token]
  );
  return updated.rows[0]?.confirm_token || token;
}

async function loadConfirmByToken(token, clinicId) {
  const value = String(token || '').trim();
  if (!value) return null;
  const result = await query(
    `SELECT id, clinic_id, patient_name, treatment_name, starts_at,
            status::text AS status, patient_confirmed_at, confirmation_state,
            confirm_token
     FROM bookings
     WHERE confirm_token = $1
       AND ($2::uuid IS NULL OR clinic_id = $2)
       AND COALESCE(booking_kind, 'visit') = 'visit'
     LIMIT 1`,
    [value, clinicId || null]
  );
  return result.rows[0] || null;
}

async function confirmByToken(token, clinicId) {
  const row = await loadConfirmByToken(token, clinicId);
  if (!row) return null;
  const updated = await query(
    `UPDATE bookings
     SET patient_confirmed_at = COALESCE(patient_confirmed_at, NOW()),
         confirmation_state = 'confirmed',
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, patient_name, starts_at, treatment_name, patient_confirmed_at, confirmation_state`,
    [row.id]
  );
  return updated.rows[0] || null;
}

module.exports = {
  newConfirmToken,
  attachConfirmToken,
  loadConfirmByToken,
  confirmByToken,
};
