-- Notification truth for the n8n Concierge/Twilio port.
-- Never treat a row as sent until Twilio returns a SID.

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

ALTER TABLE notification_locks
  ADD COLUMN IF NOT EXISTS hit_count INT NOT NULL DEFAULT 1;

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

CREATE INDEX IF NOT EXISTS idx_bookings_sms_sid
  ON bookings (sms_last_sid);
