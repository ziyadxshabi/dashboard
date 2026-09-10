-- Law 09-08: SMS consent is opt-in. Do not rewrite historical true values.

ALTER TABLE waitlist
  ALTER COLUMN sms_consent SET DEFAULT false;

ALTER TABLE patients
  ALTER COLUMN sms_consent SET DEFAULT false;
