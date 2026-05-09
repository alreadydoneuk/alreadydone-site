-- Migration 007: order fields written by Stripe webhook and read by provision agent
-- Run in Supabase SQL editor before first live payment

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS stripe_session_id       TEXT,
  ADD COLUMN IF NOT EXISTS customer_email           TEXT,
  ADD COLUMN IF NOT EXISTS customer_first_name      TEXT,
  ADD COLUMN IF NOT EXISTS order_domain             TEXT,
  ADD COLUMN IF NOT EXISTS order_tier               INTEGER,
  ADD COLUMN IF NOT EXISTS order_email_count        INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS order_email_prefixes     TEXT,   -- JSON array e.g. '["info","hello"]'
  ADD COLUMN IF NOT EXISTS order_include_report     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS order_pages              TEXT,   -- JSON array of page specs
  ADD COLUMN IF NOT EXISTS registered_domain        TEXT,
  ADD COLUMN IF NOT EXISTS pages_hostname           TEXT,
  ADD COLUMN IF NOT EXISTS pages_project_name       TEXT,
  ADD COLUMN IF NOT EXISTS delivering_started_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_report_sent_at      TIMESTAMPTZ;
