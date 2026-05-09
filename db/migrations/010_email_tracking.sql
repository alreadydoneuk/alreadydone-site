-- Migration 010: Email engagement tracking columns
-- Populated by the Resend webhook (api/resend-webhook.js)
-- Run in Supabase SQL editor

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS email_opened_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_link_clicked_at TIMESTAMPTZ;

-- Index for quick lookup of recently opened / clicked prospects
CREATE INDEX IF NOT EXISTS idx_businesses_email_opened ON businesses (email_opened_at)
  WHERE email_opened_at IS NOT NULL;
