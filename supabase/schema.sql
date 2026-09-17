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
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
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

-- Data API lockdown (keep in sync with
-- supabase/migrations/20260917120000_lockdown_public_data_api.sql).
-- Staff handlers use the server pg pool as postgres (BYPASSRLS).
-- anon / authenticated must not read or mutate public tables.
-- Local Docker skips REVOKE / policies when those roles are absent.

DO $$
DECLARE
  r record;
  has_anon boolean;
  has_authenticated boolean;
BEGIN
  has_anon := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
  has_authenticated := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');

  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relispartition
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      r.schema_name,
      r.table_name
    );

    IF has_anon AND has_authenticated THEN
      EXECUTE format(
        'DROP POLICY IF EXISTS deny_client_roles ON %I.%I',
        r.schema_name,
        r.table_name
      );
      EXECUTE format(
        'CREATE POLICY deny_client_roles ON %I.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
        r.schema_name,
        r.table_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
      REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin')
       AND pg_has_role(current_user, 'supabase_admin', 'MEMBER') THEN
      ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
        REVOKE ALL ON TABLES FROM anon, authenticated;
      ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
        REVOKE ALL ON SEQUENCES FROM anon, authenticated;
      ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
        REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
    END IF;
  END IF;
END $$;
