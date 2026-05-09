-- 002_email_type.sql
-- Classifies the contact email found for each business.
-- 'generic' = consumer domain (gmail, hotmail, etc.) — email goes directly to the owner.
-- 'business' = custom domain email — may go to a shared inbox or receptionist.
-- NULL = email not yet discovered.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS email_type TEXT CHECK (email_type IN ('generic', 'business'));

CREATE INDEX IF NOT EXISTS idx_businesses_email_type ON businesses (email_type)
  WHERE email_type IS NOT NULL;
