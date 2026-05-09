-- 004_google_reviews.sql
-- Stores real Google review text fetched via Places API (Preferred SKU).
-- Up to 5 reviews per business, stored as JSONB array of {rating, text, author, time_ago}.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS google_reviews JSONB;

CREATE INDEX IF NOT EXISTS idx_businesses_google_reviews
  ON businesses USING gin(google_reviews)
  WHERE google_reviews IS NOT NULL;
