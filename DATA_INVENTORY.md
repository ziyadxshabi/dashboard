# Data inventory — DentaFlow OS

Field → purpose → retention. **Address and CIN are not collected and must not be added.**

This is an engineering inventory, not a CNDP filing.

## Patients (`patients`)

- `phone_e164` — join the dossier and send SMS — kept until erase / end of care
- `display_name` — identify the patient in roster and waitlist — until erase
- `email` — optional reminders — until erase
- `allergies`, `chronic_conditions`, `preferred_anesthetic`, `last_xray_on`, `clinical_notes` — clinical care inside the cabinet — until erase
- `insurance_type` (`none` / `cnss` / `cnops` / `prive`) — expected copay hint — until erase
- `sms_consent`, `consent` timestamp on waitlist — Loi 09-08 opt-in — until withdrawn or erase

**Not stored:** home address, CIN, passport, family status, photos of ID.

## Bookings (`bookings`)

- `patient_name`, `patient_phone`, `patient_email` — run the visit — kept on the slot after erase as `Anonymisé` / `erased` so the calendar stays consistent
- `starts_at`, `duration_min`, `buffer_min`, `status`, `treatment_name`, `charge_mad` — operations and MAD/hour KPI — retained with the slot
- `notes` — visit notes — cleared on erase

## Waitlist (`waitlist`)

- name, phone, priority, notes, `sms_consent`, `consent_at` — fill gaps and SMS — anonymized on erase

## Staff (`staff_users`)

- username, scrypt password hash, role, display name — login — while the account exists

## Messages

- `sms_messages`, `sms_dispatch_log` — proof a message was sent (Twilio SID) — operational log
- `audit_events` — who exported, erased, patched a dossier, or added waitlist — operational log

## Third parties (clinic-configured)

Cal.com (public booking), Twilio (SMS), Vercel (app), PostgreSQL/Supabase (database), optional Resend and Upstash. See `docs/legal/` after Wave D.
