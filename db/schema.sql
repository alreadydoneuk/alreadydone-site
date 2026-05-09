-- Run this in Supabase SQL editor to set up the database

CREATE TABLE IF NOT EXISTS queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  region TEXT,
  status TEXT DEFAULT 'pending',
  last_run_at TIMESTAMPTZ,
  times_run INT DEFAULT 0,
  businesses_found INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(category, location)
);

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  name TEXT NOT NULL,
  category TEXT,
  location TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  domain TEXT,
  place_id TEXT UNIQUE,

  -- Research
  website_status TEXT, -- 'parked' | 'broken' | 'none' | 'live'
  tier INT,            -- 1 = parked domain (best) | 2 = no website at all | 0 = skip
  google_rating NUMERIC(2,1),
  review_count INT,

  -- Generated site
  template_html TEXT,
  template_screenshot TEXT,
  site_slug TEXT UNIQUE,

  -- Pipeline state
  pipeline_status TEXT DEFAULT 'researched',
  -- researched | template_built | emailed | follow_up_sent | dropped | paid | delivered

  dropped_at_stage TEXT,
  drop_reason TEXT,
  drop_reason_notes TEXT,

  -- Email tracking
  first_email_sent_at TIMESTAMPTZ,
  follow_up_sent_at TIMESTAMPTZ,
  last_reply_at TIMESTAMPTZ,
  reply_count INT DEFAULT 0,
  response_sentiment TEXT,

  -- Domain suggestions
  domain_suggestions JSONB,

  -- Commercial
  stripe_invoice_id TEXT,
  invoice_sent_at TIMESTAMPTZ,
  invoice_amount NUMERIC(8,2) DEFAULT 99.00,
  paid_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  direction TEXT,
  content_summary TEXT,
  raw_content TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT DEFAULT 'already_done',
  business_id UUID REFERENCES businesses(id),
  type TEXT NOT NULL,
  category TEXT,
  amount NUMERIC(8,2) NOT NULL,
  currency TEXT DEFAULT 'GBP',
  description TEXT,
  stripe_payment_id TEXT,
  tax_year TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at on businesses
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER businesses_updated_at
  BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
