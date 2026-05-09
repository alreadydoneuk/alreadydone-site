-- Migration 005: WHOIS metadata + enrichment tracking
-- Run in Supabase SQL editor

-- WHOIS metadata for Dark cohort businesses (domain registered, no working site)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS whois_registrar       TEXT,
  ADD COLUMN IF NOT EXISTS whois_registered_date DATE,
  ADD COLUMN IF NOT EXISTS whois_expiry_date     DATE,
  ADD COLUMN IF NOT EXISTS whois_nameservers     TEXT[],
  ADD COLUMN IF NOT EXISTS domain_has_mx         BOOLEAN;

-- Separate enrichment attempt tracking per strategy
-- Keeps email_confidence free to reflect actual result quality
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS serper_attempted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whois_attempted_at    TIMESTAMPTZ;

-- cohort label to make queries explicit and avoid re-deriving from website_status
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS cohort TEXT
    GENERATED ALWAYS AS (
      CASE
        WHEN category IN (
          'web developer','web designer','website designer','seo consultant',
          'it consultant','it support','app developer','software company',
          'digital marketing agency','marketing consultant','internet marketing service',
          'graphic designer'
        ) THEN 'filtered'
        WHEN website_status = 'live' THEN 'active'
        WHEN website_status IN ('none','social') THEN 'ghost'
        WHEN website_status IN ('parked','broken','broken_dns','broken_server','coming_soon','seo_doorway') THEN 'dark'
        ELSE 'unknown'
      END
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_businesses_cohort ON businesses (cohort);
CREATE INDEX IF NOT EXISTS idx_businesses_serper_attempted ON businesses (serper_attempted_at) WHERE serper_attempted_at IS NULL;
