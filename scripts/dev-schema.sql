-- Local/dev schema for Wave 1 operational APIs.
-- Clinic dates are interpreted in Africa/Casablanca by the SQL in the handlers.
-- Canonical Postgres (UUID, enums, overlap guard) lives in supabase/schema.sql.

CREATE TABLE IF NOT EXISTS bookings (
  id              BIGSERIAL PRIMARY KEY,
  clinic_id       TEXT NOT NULL,
  cal_booking_uid TEXT,
  patient_name    TEXT NOT NULL DEFAULT '',
  patient_phone   TEXT NOT NULL DEFAULT '',
  treatment_name  TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'En attente',
  starts_at       TIMESTAMPTZ NOT NULL,
  duration_min    INTEGER,
  buffer_min      INTEGER NOT NULL DEFAULT 10,
  booking_kind    TEXT NOT NULL DEFAULT 'visit',
  cancel_reason   TEXT,
  care_started_at TIMESTAMPTZ,
  notes           TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS bookings_clinic_starts_idx
  ON bookings (clinic_id, starts_at);

CREATE TABLE IF NOT EXISTS waitlist (
  id              BIGSERIAL PRIMARY KEY,
  clinic_id       TEXT NOT NULL,
  patient_name    TEXT NOT NULL,
  patient_phone   TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'Normale',
  notes           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS waitlist_clinic_status_idx
  ON waitlist (clinic_id, status, created_at DESC);
