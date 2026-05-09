-- Email block list: persists false positives so no code changes are needed.
-- Populated automatically by the enrichment agent's frequency detector.
-- Seeded with all manually identified false positives from earlier runs.

CREATE TABLE IF NOT EXISTS email_blocklist (
  email       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL DEFAULT 'frequency_detection',
  occurrences INT,
  blocked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: all known false positives identified manually
INSERT INTO email_blocklist (email, reason, occurrences) VALUES
  ('qasemejaz85@gmail.com',          'manual_review', 56),
  ('lewis@outrank.co.uk',             'manual_review', NULL),
  ('support@housejester.com',         'manual_review', NULL),
  ('cs@realpeoplemedia.co.uk',        'manual_review', NULL),
  ('support@threebestrated.co.uk',    'manual_review', NULL),
  ('hello@drivingschoolfinder.co.uk', 'manual_review', NULL),
  ('hello@getcarclean.com',           'manual_review', NULL),
  ('edinburghclinic@napiers.net',     'manual_review', NULL),
  ('ecss@edinburgh.gov.uk',           'manual_review', NULL),
  ('cluboffice@porscheclubgb.com',    'manual_review', NULL),
  ('support@poyst.com',               'frequency_detection', 8)
ON CONFLICT (email) DO NOTHING;
