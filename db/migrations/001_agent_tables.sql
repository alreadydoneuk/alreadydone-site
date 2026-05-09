-- Run this in Supabase SQL editor (or via psql)
-- Creates the two tables needed for the management agent fleet

CREATE TABLE IF NOT EXISTS token_usage (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent       TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  input_tokens  INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cost_usd    NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_agent       ON token_usage (agent);
CREATE INDEX IF NOT EXISTS idx_token_usage_created_at  ON token_usage (created_at);

CREATE TABLE IF NOT EXISTS agent_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent        TEXT NOT NULL,
  report_text  TEXT NOT NULL,
  word_count   INT,
  ea_delivered BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_reports_agent       ON agent_reports (agent);
CREATE INDEX IF NOT EXISTS idx_agent_reports_created_at  ON agent_reports (created_at);
CREATE INDEX IF NOT EXISTS idx_agent_reports_delivered   ON agent_reports (ea_delivered);
