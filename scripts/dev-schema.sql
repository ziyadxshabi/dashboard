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
  notes           TEXT NOT NULL DEFAULT '',
  patient_email   TEXT,
  sms_status      TEXT,
  sms_last_error  TEXT,
  sms_last_sid    TEXT
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

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN DEFAULT false;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS notification_locks (
  lock_key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_messages (
  id TEXT PRIMARY KEY,
  clinic_id TEXT,
  booking_id TEXT,
  waitlist_id TEXT,
  purpose TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  twilio_sid TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS waitlist_clinic_status_idx
  ON waitlist (clinic_id, status, created_at DESC);

-- Patient identity (UUID clinics) lives in supabase/schema.sql.
-- Insurance v2 columns: insurance_member_number, mutuelle_name,
-- beneficiary_of_patient_id, beneficiary_relation.

-- Local mirror of Phase 0 catalog. clinic_id stays TEXT in this file.
CREATE TABLE IF NOT EXISTS act_reference (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'soins', 'chirurgie', 'prothese', 'orthodontie', 'parodontologie'
  )),
  coefficient NUMERIC NULL,
  letter_key TEXT NOT NULL DEFAULT 'soins' CHECK (letter_key IN ('soins', 'prothese')),
  tnr_mad NUMERIC(12, 2) NULL,
  requires_prior_approval BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS clinic_act_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id TEXT NOT NULL,
  act_code TEXT REFERENCES act_reference(code),
  custom_label TEXT,
  price_mad NUMERIC(12, 2) NOT NULL CHECK (price_mad >= 0),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (act_code IS NOT NULL OR NULLIF(custom_label, '') IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_act_prices_clinic_act
  ON clinic_act_prices (clinic_id, act_code)
  WHERE act_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinic_act_prices_clinic
  ON clinic_act_prices (clinic_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  amount_mad NUMERIC(12, 2) NOT NULL CHECK (amount_mad > 0),
  method TEXT NOT NULL CHECK (method IN ('especes', 'cheque', 'carte', 'virement')),
  booking_id TEXT,
  plan_id TEXT,
  note TEXT,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_patient
  ON payments (clinic_id, patient_id, paid_at DESC);
