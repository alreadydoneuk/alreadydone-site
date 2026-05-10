-- Migration 013: Pre-launch data reset
-- Clears all test email, site-building, and order activity.
-- Safe: preserves all business directory data, enrichment, and prospect qualification.
-- Run ONCE in Supabase SQL editor before going live.
-- DO NOT run after real emails have been sent to real customers.

BEGIN;

-- ── 1. Wipe activity tables (full truncate) ──────────────────────────────────
-- NOT touched: queue (research progress), email_blocklist (curated, permanent)

TRUNCATE TABLE interactions;
TRUNCATE TABLE finance;
TRUNCATE TABLE report_history;
TRUNCATE TABLE report_snapshots;
TRUNCATE TABLE token_usage;
TRUNCATE TABLE agent_reports;

-- ── 2. Clear all activity columns on businesses ──────────────────────────────
-- NOT touched: directory data, enrichment, prospect qualification (is_prospect,
-- lead_temperature, do_not_contact), email_type/confidence, WHOIS, fl_* columns.

UPDATE businesses SET
  -- Email outreach
  first_email_sent_at        = NULL,
  follow_up_sent_at          = NULL,
  last_reply_at              = NULL,
  reply_count                = NULL,
  response_sentiment         = NULL,
  outreach_message_id        = NULL,
  email_opened_at            = NULL,
  email_link_clicked_at      = NULL,

  -- Site building
  template_html              = NULL,
  template_screenshot        = NULL,
  preview_url                = NULL,
  site_slug                  = NULL,

  -- Orders & delivery
  stripe_session_id          = NULL,
  customer_email             = NULL,
  customer_first_name        = NULL,
  order_domain               = NULL,
  order_tier                 = NULL,
  order_email_count          = NULL,
  order_email_prefixes       = NULL,
  order_include_report       = NULL,
  order_pages                = NULL,
  registered_domain          = NULL,
  pages_hostname             = NULL,
  pages_project_name         = NULL,
  delivering_started_at      = NULL,
  delivered_at               = NULL,
  paid_at                    = NULL,
  last_report_sent_at        = NULL,

  -- Invoicing
  invoice_amount             = NULL,
  invoice_sent_at            = NULL,
  stripe_invoice_id          = NULL,

  -- Drop metadata
  dropped_at_stage           = NULL,
  drop_reason                = NULL,
  drop_reason_notes          = NULL,

  -- Report subscription
  report_stripe_subscription_id = NULL,
  free_trial_report_sent_at     = NULL,
  last_snapshot_at              = NULL;

-- ── 3. Reset pipeline_status to 'researched' ────────────────────────────────
-- All businesses that entered the outreach/delivery pipeline during testing
-- are returned to 'researched': qualified, enriched, ready for real outreach.

UPDATE businesses
SET pipeline_status = 'researched'
WHERE pipeline_status IN (
  'template_built',
  'emailed',
  'follow_up_sent',
  'engaged',
  'nurturing',
  'payment_pending',
  'delivering',
  'delivered',
  'dropped'
);

COMMIT;
