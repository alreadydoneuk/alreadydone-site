-- API usage log — tracks external API calls and estimated costs for the weekly finance report.
-- One row per agent run per API (e.g. research-agent logs Places calls after each queue item).

CREATE TABLE IF NOT EXISTS api_usage (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  api         text NOT NULL,        -- 'google_places', 'serper', 'resend', 'pexels'
  agent       text,                 -- which agent made the calls
  calls       integer NOT NULL DEFAULT 1,
  cost_usd    numeric(10,6),        -- estimated USD cost (null = free/unknown)
  notes       text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_usage_api_created ON api_usage (api, created_at DESC);
CREATE INDEX IF NOT EXISTS api_usage_created ON api_usage (created_at DESC);
