-- DentaFlow OS — canonical multi-clinic schema (Supabase / PostgreSQL)
-- Enums, tenant tables, indexes, and Temara seed rows.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE appointment_status AS ENUM (
    'Confirme',
    'En attente',
    'En salle d''attente',
    'En soin',
    'Termine',
    'No-show',
    'Annule'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE waitlist_priority AS ENUM (
    'Faible',
    'Moyenne',
    'Haute',
    'Urgent'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE staff_role AS ENUM (
    'doctor',
    'assistant'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS clinics (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  phone            TEXT,
  theme_preset     TEXT DEFAULT 'oak-lounge',
  theme_tokens     JSONB DEFAULT '{}'::jsonb,
  cal_event_type_id TEXT,
  twilio_from      TEXT,
  sms_booking_url  TEXT,
  buffer_min       INT NOT NULL DEFAULT 10,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          staff_role NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (clinic_id, username)
);

CREATE TABLE IF NOT EXISTS bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  cal_booking_uid TEXT UNIQUE,
  patient_name    TEXT NOT NULL,
  patient_phone   TEXT NOT NULL,
  treatment_name  TEXT,
  status          appointment_status DEFAULT 'Confirme',
  starts_at       TIMESTAMPTZ NOT NULL,
  duration_min    INT DEFAULT 30,
  buffer_min      INT NOT NULL DEFAULT 10,
  booking_kind    TEXT NOT NULL DEFAULT 'visit',
  cancel_reason   TEXT,
  care_started_at TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  CHECK (booking_kind IN ('visit', 'block', 'emergency_hold')),
  CHECK (
    cancel_reason IS NULL
    OR cancel_reason IN ('oublie', 'cout', 'reprogramme', 'autre')
  )
);

CREATE TABLE IF NOT EXISTS waitlist (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_name   TEXT NOT NULL,
  patient_phone  TEXT NOT NULL,
  priority       waitlist_priority DEFAULT 'Moyenne',
  notes          TEXT,
  status         TEXT DEFAULT 'active',
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  booking_id   UUID REFERENCES bookings(id) ON DELETE SET NULL,
  patient_name TEXT,
  author_name  TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now(),
  pinned       BOOLEAN NOT NULL DEFAULT false,
  category     TEXT NOT NULL DEFAULT 'general'
);

CREATE INDEX IF NOT EXISTS idx_bookings_clinic_starts
  ON bookings (clinic_id, starts_at);

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Minute arithmetic on timestamptz is STABLE in Postgres (DST). Morocco has no DST
-- in this product; mark IMMUTABLE so btree_gist exclusion can use the range.
CREATE OR REPLACE FUNCTION public.booking_busy_range(
  p_starts_at timestamptz,
  p_duration_min integer,
  p_buffer_min integer
) RETURNS tstzrange
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT tstzrange(
    p_starts_at,
    p_starts_at + make_interval(
      mins => GREATEST(COALESCE(p_duration_min, 30), 1)
        + GREATEST(COALESCE(p_buffer_min, 10), 0)
    ),
    '[)'
  );
$fn$;

-- Overbooking guard: active visits/blocks/holds cannot overlap, including clinic buffer.
-- Wall clock for clinic dates is Africa/Casablanca (no DST in this OS).
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_clinic_time_excl;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_clinic_time_excl
  EXCLUDE USING gist (
    clinic_id WITH =,
    public.booking_busy_range(starts_at, duration_min, buffer_min) WITH &&
  )
  WHERE (status NOT IN ('Annule', 'No-show'));

CREATE TABLE IF NOT EXISTS recalls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_name TEXT NOT NULL,
  patient_phone TEXT NOT NULL,
  due_on DATE NOT NULL,
  treatment_name TEXT,
  source_booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now(),
  CHECK (status IN ('open', 'done'))
);

CREATE INDEX IF NOT EXISTS idx_recalls_clinic_due
  ON recalls (clinic_id, status, due_on);

CREATE INDEX IF NOT EXISTS idx_waitlist_clinic_status
  ON waitlist (clinic_id, status);

CREATE INDEX IF NOT EXISTS idx_team_notes_clinic_created
  ON team_notes (clinic_id, created_at);

CREATE INDEX IF NOT EXISTS idx_team_notes_clinic_pinned_posted
  ON team_notes (clinic_id, pinned DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS sms_dispatch_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  recipient_count INT NOT NULL,
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_dispatch_log_clinic_created
  ON sms_dispatch_log (clinic_id, created_at DESC);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS patient_email TEXT;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS sms_status TEXT;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS sms_last_error TEXT;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS sms_last_sid TEXT;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS last_notified_batch TEXT;

CREATE TABLE IF NOT EXISTS notification_locks (
  lock_key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  hit_count INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_locks_expires
  ON notification_locks (expires_at);

CREATE TABLE IF NOT EXISTS sms_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  waitlist_id UUID REFERENCES waitlist(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  twilio_sid TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_clinic_created
  ON sms_messages (clinic_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_messages_sid
  ON sms_messages (twilio_sid);

-- Seed: Clinique Dentaire Témara Mall
INSERT INTO clinics (slug, name)
VALUES ('temara', 'Clinique Dentaire Témara Mall')
ON CONFLICT (slug) DO NOTHING;

-- Seed staff for slug 'temara'.
-- password_hash values are scrypt placeholders produced by api/_lib/auth-crypto.hashPassword
-- for the local-dev password; replace in production.
INSERT INTO staff_users (clinic_id, username, password_hash, role, display_name)
SELECT
  c.id,
  'docteur',
  'scrypt$NubIFQs9J77PK2HSco4dOQ==$ZPgG2hJLvW2IxqxHXawomMkz4hL5x1nS6aHmWInRqioyFMLigfPjaM4p6vJ1HBLZY+URU+dQhATQzkowNMJtBw==',
  'doctor',
  'Dr. Témara'
FROM clinics c
WHERE c.slug = 'temara'
ON CONFLICT (clinic_id, username) DO NOTHING;

INSERT INTO staff_users (clinic_id, username, password_hash, role, display_name)
SELECT
  c.id,
  'assistante',
  'scrypt$+2lnkQa9h/BoZXfd/Cl4Kw==$SzKwNwX2/T/MPeYrrJGlxJdyhQALO3zAMi6T59aKI7078zr2YdTTIbw9Lhw19RbUUyVtmZvUQOlZpti1I4/Y9A==',
  'assistant',
  'Assistante Témara'
FROM clinics c
WHERE c.slug = 'temara'
ON CONFLICT (clinic_id, username) DO NOTHING;
