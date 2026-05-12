# Already Done — TODO

## 🔴 URGENT

### Run SQL migration 014: api_usage table
**Needed for:** API cost tracking in the finance agent weekly briefing.

Go to **Supabase Dashboard → SQL Editor** and paste:

```sql
CREATE TABLE IF NOT EXISTS api_usage (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  api         text NOT NULL,
  agent       text,
  calls       integer NOT NULL DEFAULT 1,
  cost_usd    numeric(10,6),
  notes       text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_usage_api_created ON api_usage (api, created_at DESC);
CREATE INDEX IF NOT EXISTS api_usage_created ON api_usage (created_at DESC);
```

Until this runs, the finance agent will report $0 for Places and Serper usage, and
the research/enrichment agents will log a silent console error on each run.

File: `db/migrations/014_api_usage.sql`

### Clear enrichment backlog tonight
**Current state:** 1,105 Spotted businesses with no email. At current rate (90 Ghost/day) that's 12+ days to clear — and research keeps adding more each night.

**Tonight:** Run enrichment manually several times to clear it down:
```bash
for i in {1..8}; do
  node scripts/run-enrichment.js
  sleep 5
done
```
That'll process ~400 more businesses in one sitting (~$1.20 in Serper). Serper balance is 44,847 credits — plenty of headroom.

### Permanently increase enrichment rate to keep pace with research
**Problem:** Nightly research adds up to 200 Places API calls worth of new businesses. Enrichment at 90 Ghost/day can't keep up once the pipeline is running at full speed.

**Fix:** Two-part change:
1. Bump `BATCH_SIZE` in `enrichment-agent.js` from 50 → 100 (60 Ghost + 40 Dark per run)
2. Add 2 more cron slots — currently 3x/day at 09:00, 13:00, 16:00; add 07:00 and 19:00

Result: 60 Ghost × 5 runs = **300 Ghost enriched/day** vs current 90. Serper runway stays ~50 days at that rate (still comfortable from the 44,847 balance).

Files to change: `agents/enrichment-agent.js` (BATCH_SIZE), `crontab` (add two slots).

---

## Normal

_(nothing yet)_
