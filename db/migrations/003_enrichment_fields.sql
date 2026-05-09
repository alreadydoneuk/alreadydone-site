-- 003_enrichment_fields.sql
-- Supports directory enrichment for no-website businesses.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS email_confidence TEXT CHECK (email_confidence IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS email_source     TEXT,
  ADD COLUMN IF NOT EXISTS outreach_route   TEXT CHECK (outreach_route IN ('email', 'phone'));

CREATE INDEX IF NOT EXISTS idx_businesses_enrichment
  ON businesses (website_status, email_confidence)
  WHERE website_status = 'none';
