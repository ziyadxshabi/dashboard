-- Clinic opening hours, SMS pause, and richer patient dossiers.
-- Used by walk-in / next-gap and PATCH /api/roster?action=clinic-settings.

ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS day_start TEXT NOT NULL DEFAULT '08:00';

ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS day_end TEXT NOT NULL DEFAULT '19:00';

ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS sms_reminders_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS email TEXT;

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS clinical_notes TEXT;
