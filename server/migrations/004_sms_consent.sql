-- Proof of SMS consent: when and how the person agreed (keyword text, website checkbox, staff-recorded).
alter table contacts add column if not exists sms_consent_at timestamptz;
alter table contacts add column if not exists sms_consent_source text;
