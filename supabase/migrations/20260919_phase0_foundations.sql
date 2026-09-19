-- Phase 0 foundations (chunk 1): NGAP act catalog + clinic prices.
-- act_reference is the intentional global exception to clinic_id tenancy
-- (shared nomenclature). clinic_act_prices is clinic-scoped.
-- Catalog rows are deactivated (active = false), never deleted.
-- Insurance paperwork (future) may only include rows with act_code IS NOT NULL.
-- Custom acts (blanchiment, implants, zircone…) are price-only.
--
-- TODO(verify): 2nd coefficient on some surgical acts (D622, D726, D729-D732, D741, D745-D747)
-- TODO(verify): CNSS coverage of periodontal acts D709-D711
-- TODO(verify): consultation TNR (150 vs 250 MAD post-2020)
-- TODO(verify): dental reimbursement rate 70% vs 80%
--
-- Apply NGAP rows with: psql -f supabase/seeds/act_reference_seed.sql
-- Placeholder prices target clinics.slug = 'temara' only (beta). Future
-- clinics set prices via the doctor Réglages UI.

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
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
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

-- PLACEHOLDER prices — clinic edits real prices via UI (doctor role)
-- NGAP rows are skipped until act_reference is seeded (FK-safe re-run).
-- Custom acts (act_code IS NULL) are not covered by the partial unique
-- index, so uniqueness is enforced with NOT EXISTS + IS NOT DISTINCT FROM.
INSERT INTO clinic_act_prices (clinic_id, act_code, custom_label, price_mad)
SELECT c.id, v.act_code, v.custom_label, v.price_mad
FROM clinics c
CROSS JOIN (VALUES
  ('D708', NULL::text, 400::numeric),
  ('D700', NULL, 400),
  ('D701', NULL, 500),
  ('D702', NULL, 600),
  ('D704', NULL, 800),
  ('D705', NULL, 1000),
  ('D706', NULL, 1200),
  ('D713', NULL, 400),
  ('D720', NULL, 1500),
  ('D754', NULL, 2500),
  ('D758', NULL, 1000),
  ('D773', NULL, 6000),
  (NULL, 'Consultation', 250),
  (NULL, 'Blanchiment', 3000),
  (NULL, 'Implant + couronne', 8000),
  (NULL, 'Couronne zircone', 4000)
) AS v(act_code, custom_label, price_mad)
WHERE c.slug = 'temara'
  AND (v.act_code IS NULL OR EXISTS (
    SELECT 1 FROM act_reference r WHERE r.code = v.act_code
  ))
  AND NOT EXISTS (
    SELECT 1 FROM clinic_act_prices p
    WHERE p.clinic_id = c.id
      AND p.act_code IS NOT DISTINCT FROM v.act_code
      AND p.custom_label IS NOT DISTINCT FROM v.custom_label
  );
