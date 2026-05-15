-- Run in Supabase SQL editor

CREATE TABLE IF NOT EXISTS fl_articles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   TEXT UNIQUE NOT NULL,
  title                  TEXT NOT NULL,
  excerpt                TEXT NOT NULL,
  body_html              TEXT NOT NULL,
  article_type           TEXT NOT NULL CHECK (article_type IN ('top5', 'questions', 'guide', 'costs')),
  category_slug          TEXT,
  category_name          TEXT,
  area_slug              TEXT,
  area_name              TEXT,
  featured_business_slugs TEXT[] DEFAULT '{}',
  reading_time_mins      INT DEFAULT 3,
  published_at           TIMESTAMPTZ DEFAULT NOW(),
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fl_articles_category  ON fl_articles(category_slug);
CREATE INDEX IF NOT EXISTS idx_fl_articles_area       ON fl_articles(area_slug);
CREATE INDEX IF NOT EXISTS idx_fl_articles_published  ON fl_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_fl_articles_type       ON fl_articles(article_type);
