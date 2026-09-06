-- Assistant floor ops: booking kinds, occupancy clock, cancel reasons, recalls, overlap guard.
-- Clinic wall clock remains Africa/Casablanca (Morocco, no DST in this OS).

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS buffer_min INT NOT NULL DEFAULT 10;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_kind TEXT NOT NULL DEFAULT 'visit';

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS care_started_at TIMESTAMPTZ;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS buffer_min INT NOT NULL DEFAULT 10;

UPDATE bookings
SET buffer_min = COALESCE((
  SELECT c.buffer_min FROM clinics c WHERE c.id = bookings.clinic_id
), 10)
WHERE buffer_min IS DISTINCT FROM COALESCE((
  SELECT c.buffer_min FROM clinics c WHERE c.id = bookings.clinic_id
), 10);

DO $$ BEGIN
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_kind_check
    CHECK (booking_kind IN ('visit', 'block', 'emergency_hold'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE bookings
    ADD CONSTRAINT bookings_cancel_reason_check
    CHECK (
      cancel_reason IS NULL
      OR cancel_reason IN ('oublie', 'cout', 'reprogramme', 'autre')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

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

-- Deactivate later overlapping active rows so the exclusion can attach.
DO $$
DECLARE
  loser uuid;
BEGIN
  LOOP
    SELECT b2.id INTO loser
    FROM bookings b1
    JOIN bookings b2
      ON b1.clinic_id = b2.clinic_id
     AND b1.id < b2.id
     AND b1.status NOT IN ('Annule', 'No-show')
     AND b2.status NOT IN ('Annule', 'No-show')
     AND public.booking_busy_range(b1.starts_at, b1.duration_min, b1.buffer_min)
         && public.booking_busy_range(b2.starts_at, b2.duration_min, b2.buffer_min)
    LIMIT 1;
    EXIT WHEN loser IS NULL;
    UPDATE bookings
    SET status = 'Annule',
        cancel_reason = COALESCE(cancel_reason, 'autre'),
        updated_at = NOW()
    WHERE id = loser;
  END LOOP;
END $$;

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
