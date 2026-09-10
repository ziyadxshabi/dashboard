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
  day_start        TEXT NOT NULL DEFAULT '08:00',
  day_end          TEXT NOT NULL DEFAULT '19:00',
  sms_reminders_enabled BOOLEAN NOT NULL DEFAULT true,
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
  ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS last_notified_batch TEXT;

ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS messaging_channel TEXT NOT NULL DEFAULT 'sms';

ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS twilio_wa_from TEXT;

DO $$ BEGIN
  ALTER TABLE clinics
    ADD CONSTRAINT clinics_messaging_channel_check
    CHECK (messaging_channel IN ('sms', 'whatsapp'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.normalize_ma_e164(raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN compact ~ '^\+212[5-7][0-9]{8}$' THEN compact
    WHEN compact ~ '^212[5-7][0-9]{8}$' THEN '+' || compact
    WHEN compact ~ '^0[5-7][0-9]{8}$' THEN '+212' || substring(compact FROM 2)
    ELSE NULL
  END
  FROM (
    SELECT regexp_replace(COALESCE(raw, ''), '[^0-9+]', '', 'g') AS compact
  ) s;
$fn$;

CREATE TABLE IF NOT EXISTS patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  phone_e164 TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  allergies TEXT,
  chronic_conditions TEXT,
  preferred_anesthetic TEXT,
  last_xray_on DATE,
  insurance_type TEXT,
  sms_consent BOOLEAN NOT NULL DEFAULT false,
  email TEXT,
  clinical_notes TEXT,
  last_inbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, phone_e164),
  CHECK (
    insurance_type IS NULL
    OR insurance_type IN ('none', 'cnss', 'cnops', 'prive')
  )
);

CREATE INDEX IF NOT EXISTS idx_patients_clinic_phone
  ON patients (clinic_id, phone_e164);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id) ON DELETE SET NULL;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS patient_confirmed_at TIMESTAMPTZ;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS confirmation_state TEXT;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS charge_mad NUMERIC(12, 2);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES staff_users(id) ON DELETE SET NULL;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS confirm_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_confirm_token
  ON bookings (confirm_token)
  WHERE confirm_token IS NOT NULL;

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id) ON DELETE SET NULL;

ALTER TABLE recalls
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id) ON DELETE SET NULL;

ALTER TABLE team_notes
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS treatment_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('open', 'done'))
);

CREATE TABLE IF NOT EXISTS plan_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 1,
  label TEXT NOT NULL,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qty INT NOT NULL DEFAULT 0,
  reorder_at INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, name)
);

CREATE TABLE IF NOT EXISTS stock_uses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  qty INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS staff_clinic_memberships (
  staff_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, clinic_id)
);

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

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_clinic_created
  ON audit_events (clinic_id, created_at DESC);

-- Law 09-08: SMS is opt-in. Existing true rows stay true; new rows default false.
ALTER TABLE waitlist ALTER COLUMN sms_consent SET DEFAULT false;
ALTER TABLE patients ALTER COLUMN sms_consent SET DEFAULT false;

-- Seed: Clinique Dentaire Témara Mall
-- cal_event_type_id matches Temara_Dashboard/book.js DEFAULT_CAL_LINK so the
-- public clinic API can emit https://cal.com/dentaflow/temara.
INSERT INTO clinics (slug, name, cal_event_type_id)
VALUES ('temara', 'Clinique Dentaire Témara Mall', 'dentaflow/temara')
ON CONFLICT (slug) DO NOTHING;

UPDATE clinics
SET cal_event_type_id = COALESCE(NULLIF(btrim(cal_event_type_id), ''), 'dentaflow/temara')
WHERE slug = 'temara';

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

INSERT INTO staff_clinic_memberships (staff_id, clinic_id)
SELECT su.id, su.clinic_id
FROM staff_users su
ON CONFLICT DO NOTHING;
