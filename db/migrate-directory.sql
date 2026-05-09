-- Migration: expand businesses table for full directory use
-- Safe to run on the live DB — only adds columns, never drops or modifies existing ones.
-- Run in Supabase SQL editor.

ALTER TABLE businesses
  -- Directory: rich location data
  ADD COLUMN IF NOT EXISTS short_address       TEXT,
  ADD COLUMN IF NOT EXISTS postcode            TEXT,
  ADD COLUMN IF NOT EXISTS town                TEXT,
  ADD COLUMN IF NOT EXISTS latitude            NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS longitude           NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS google_maps_uri     TEXT,

  -- Directory: business classification
  ADD COLUMN IF NOT EXISTS business_status     TEXT,  -- OPERATIONAL | CLOSED_PERMANENTLY | CLOSED_TEMPORARILY
  ADD COLUMN IF NOT EXISTS google_types        TEXT[],
  ADD COLUMN IF NOT EXISTS primary_type        TEXT,
  ADD COLUMN IF NOT EXISTS primary_type_label  TEXT,

  -- Directory: rich content
  ADD COLUMN IF NOT EXISTS editorial_summary   TEXT,
  ADD COLUMN IF NOT EXISTS opening_hours       JSONB,
  ADD COLUMN IF NOT EXISTS photo_references    JSONB,
  ADD COLUMN IF NOT EXISTS price_level         INT,
  ADD COLUMN IF NOT EXISTS attributes          JSONB, -- delivery, dineIn, servesBreakfast, etc.

  -- Directory: contact
  ADD COLUMN IF NOT EXISTS phone_international TEXT,

  -- Directory: maintenance
  ADD COLUMN IF NOT EXISTS last_verified_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_category     TEXT,  -- which category search found this business

  -- Already Done pipeline flag
  ADD COLUMN IF NOT EXISTS is_prospect         BOOLEAN DEFAULT FALSE,

  -- Lead temperature (email-automation only — no phone)
  -- hot:  strong need signal + MX records exist (can email)
  -- warm: need signal present + domain exists but email unconfirmed
  -- cold: no domain / no MX / no automated contact route
  ADD COLUMN IF NOT EXISTS lead_temperature    TEXT;

-- Index for directory queries (find all businesses in an area)
CREATE INDEX IF NOT EXISTS idx_businesses_town        ON businesses(town);
CREATE INDEX IF NOT EXISTS idx_businesses_postcode    ON businesses(postcode);
CREATE INDEX IF NOT EXISTS idx_businesses_location    ON businesses(location);
CREATE INDEX IF NOT EXISTS idx_businesses_is_prospect ON businesses(is_prospect) WHERE is_prospect = TRUE;
CREATE INDEX IF NOT EXISTS idx_businesses_primary_type ON businesses(primary_type);
CREATE INDEX IF NOT EXISTS idx_businesses_status      ON businesses(business_status);

-- Spatial index for lat/lng queries (find businesses near a point)
CREATE INDEX IF NOT EXISTS idx_businesses_coords ON businesses(latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
