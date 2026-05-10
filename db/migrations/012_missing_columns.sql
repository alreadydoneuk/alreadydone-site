-- Migration 012: Document columns written by agents that were missing from migrations.
-- These columns exist in the live database but were never formally migrated.
-- Run in Supabase SQL editor to make a fresh database match production.

-- From research-agent (Google Places enrichment)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS short_address       TEXT,
  ADD COLUMN IF NOT EXISTS postcode            TEXT,
  ADD COLUMN IF NOT EXISTS town                TEXT,
  ADD COLUMN IF NOT EXISTS phone_international TEXT,
  ADD COLUMN IF NOT EXISTS source_category     TEXT,
  ADD COLUMN IF NOT EXISTS google_maps_uri     TEXT,
  ADD COLUMN IF NOT EXISTS editorial_summary   TEXT,
  ADD COLUMN IF NOT EXISTS opening_hours       JSONB,
  ADD COLUMN IF NOT EXISTS photo_references    JSONB,
  ADD COLUMN IF NOT EXISTS attributes          JSONB,
  ADD COLUMN IF NOT EXISTS google_types        JSONB,
  ADD COLUMN IF NOT EXISTS primary_type        TEXT,
  ADD COLUMN IF NOT EXISTS primary_type_label  TEXT,
  ADD COLUMN IF NOT EXISTS latitude            NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS longitude           NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS price_level         INTEGER,
  ADD COLUMN IF NOT EXISTS business_status     TEXT,
  ADD COLUMN IF NOT EXISTS is_prospect         BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS lead_temperature    TEXT CHECK (lead_temperature IN ('hot', 'warm', 'cold')),
  ADD COLUMN IF NOT EXISTS last_verified_at    TIMESTAMPTZ;

-- From site-builder-agent
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS preview_url         TEXT;

-- From reply-monitor-agent
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS reply_classification TEXT,
  ADD COLUMN IF NOT EXISTS follow_up_due_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS do_not_contact       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS website_exists       BOOLEAN;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_businesses_lead_temperature  ON businesses (lead_temperature);
CREATE INDEX IF NOT EXISTS idx_businesses_is_prospect       ON businesses (is_prospect) WHERE is_prospect = true;
CREATE INDEX IF NOT EXISTS idx_businesses_follow_up_due     ON businesses (follow_up_due_at) WHERE follow_up_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_businesses_do_not_contact    ON businesses (do_not_contact) WHERE do_not_contact = true;
