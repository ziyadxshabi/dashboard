-- ROI loops: channel adapter, inbound confirm, patients SSOT,
-- treatment plans, honest charge KPI, inventory log, memberships.
-- No paperwork tables (no invoices, slips, claims, exports).

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
  sms_consent BOOLEAN NOT NULL DEFAULT true,
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

CREATE INDEX IF NOT EXISTS idx_bookings_clinic_patient
  ON bookings (clinic_id, patient_id);

CREATE INDEX IF NOT EXISTS idx_bookings_clinic_staff
  ON bookings (clinic_id, staff_id);

ALTER TABLE waitlist
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id) ON DELETE SET NULL;

ALTER TABLE recalls
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id) ON DELETE SET NULL;

ALTER TABLE team_notes
  ADD COLUMN IF NOT EXISTS patient_id UUID REFERENCES patients(id) ON DELETE SET NULL;

INSERT INTO patients (clinic_id, phone_e164, display_name, sms_consent)
SELECT DISTINCT ON (b.clinic_id, public.normalize_ma_e164(b.patient_phone))
  b.clinic_id,
  public.normalize_ma_e164(b.patient_phone),
  COALESCE(NULLIF(btrim(b.patient_name), ''), 'Patient'),
  true
FROM bookings b
WHERE public.normalize_ma_e164(b.patient_phone) IS NOT NULL
ON CONFLICT (clinic_id, phone_e164) DO NOTHING;

INSERT INTO patients (clinic_id, phone_e164, display_name, sms_consent)
SELECT DISTINCT ON (w.clinic_id, public.normalize_ma_e164(w.patient_phone))
  w.clinic_id,
  public.normalize_ma_e164(w.patient_phone),
  COALESCE(NULLIF(btrim(w.patient_name), ''), 'Patient'),
  COALESCE(w.sms_consent, true)
FROM waitlist w
WHERE public.normalize_ma_e164(w.patient_phone) IS NOT NULL
ON CONFLICT (clinic_id, phone_e164) DO NOTHING;

INSERT INTO patients (clinic_id, phone_e164, display_name, sms_consent)
SELECT DISTINCT ON (r.clinic_id, public.normalize_ma_e164(r.patient_phone))
  r.clinic_id,
  public.normalize_ma_e164(r.patient_phone),
  COALESCE(NULLIF(btrim(r.patient_name), ''), 'Patient'),
  true
FROM recalls r
WHERE public.normalize_ma_e164(r.patient_phone) IS NOT NULL
ON CONFLICT (clinic_id, phone_e164) DO NOTHING;

UPDATE bookings b
SET patient_id = p.id
FROM patients p
WHERE b.patient_id IS NULL
  AND p.clinic_id = b.clinic_id
  AND p.phone_e164 = public.normalize_ma_e164(b.patient_phone);

UPDATE waitlist w
SET patient_id = p.id
FROM patients p
WHERE w.patient_id IS NULL
  AND p.clinic_id = w.clinic_id
  AND p.phone_e164 = public.normalize_ma_e164(w.patient_phone);

UPDATE recalls r
SET patient_id = p.id
FROM patients p
WHERE r.patient_id IS NULL
  AND p.clinic_id = r.clinic_id
  AND p.phone_e164 = public.normalize_ma_e164(r.patient_phone);

UPDATE team_notes n
SET patient_id = p.id
FROM patients p
WHERE n.patient_id IS NULL
  AND p.clinic_id = n.clinic_id
  AND p.display_name IS NOT NULL
  AND n.patient_name IS NOT NULL
  AND lower(btrim(p.display_name)) = lower(btrim(n.patient_name));

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

CREATE INDEX IF NOT EXISTS idx_treatment_plans_clinic_patient
  ON treatment_plans (clinic_id, patient_id, status);

CREATE TABLE IF NOT EXISTS plan_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 1,
  label TEXT NOT NULL,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_steps_plan_position
  ON plan_steps (plan_id, position);

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

CREATE INDEX IF NOT EXISTS idx_stock_uses_booking
  ON stock_uses (booking_id);

CREATE TABLE IF NOT EXISTS staff_clinic_memberships (
  staff_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, clinic_id)
);

INSERT INTO staff_clinic_memberships (staff_id, clinic_id)
SELECT su.id, su.clinic_id
FROM staff_users su
ON CONFLICT DO NOTHING;
