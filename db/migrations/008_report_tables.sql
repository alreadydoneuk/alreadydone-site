-- Migration 008: SEO/business intelligence report system
-- Run in Supabase SQL editor

-- Snapshot of all data metrics per customer per period
-- period: 'baseline' (captured at point of delivery) or 'YYYY-MM' (monthly)
CREATE TABLE IF NOT EXISTS report_snapshots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period                TEXT NOT NULL,        -- 'baseline' | '2026-05'
  captured_at           TIMESTAMPTZ DEFAULT NOW(),

  -- Google Places metrics
  google_rating         NUMERIC(2,1),
  review_count          INTEGER,
  photo_count           INTEGER,
  recent_reviews        JSONB,                -- [{text, rating, author, relative_date}]

  -- Local search rank (via Serper)
  search_keyword        TEXT,                 -- e.g. "plumber Edinburgh"
  search_rank           INTEGER,              -- position in local pack, null = not in top 10
  competitors           JSONB,                -- [{title, rating, review_count, address, website, rank}]

  -- Companies House new competitors in area
  new_competitors_30d   INTEGER DEFAULT 0,
  new_competitor_names  JSONB,                -- ["Rowanwood Heating Ltd", ...]

  -- Site health
  uptime_ok             BOOLEAN,
  site_load_ms          INTEGER,
  has_meta_description  BOOLEAN,
  has_title_tag         BOOLEAN,

  UNIQUE(business_id, period)
);

-- Record of every report sent: tracks opens and CTA clicks
CREATE TABLE IF NOT EXISTS report_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period            TEXT NOT NULL,        -- '2026-05'
  report_type       TEXT NOT NULL,        -- 'full' | 'free_trial'
  sent_at           TIMESTAMPTZ DEFAULT NOW(),
  email_sent_to     TEXT,
  subject           TEXT,
  tracking_id       TEXT UNIQUE DEFAULT gen_random_uuid()::TEXT,
  opened_at         TIMESTAMPTZ,
  cta_clicked_at    TIMESTAMPTZ,

  UNIQUE(business_id, period)
);

-- Additional columns on businesses table
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS report_stripe_subscription_id  TEXT,
  ADD COLUMN IF NOT EXISTS free_trial_report_sent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_snapshot_at               TIMESTAMPTZ;
