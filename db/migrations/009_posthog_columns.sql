-- Migration 009: Add PostHog analytics columns to report_snapshots
-- Run in Supabase SQL editor after 008_report_tables.sql

ALTER TABLE report_snapshots
  ADD COLUMN IF NOT EXISTS visitors        INTEGER,
  ADD COLUMN IF NOT EXISTS pageviews       INTEGER,
  ADD COLUMN IF NOT EXISTS top_pages       JSONB,    -- [{path, views, pct}]
  ADD COLUMN IF NOT EXISTS traffic_sources JSONB;    -- {organic, direct, social, other} as percentages
