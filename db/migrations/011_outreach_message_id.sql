-- Migration 011: outreach_message_id for In-Reply-To threading
-- Stores the Resend message ID so replies can be matched back to the business

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS outreach_message_id TEXT;
