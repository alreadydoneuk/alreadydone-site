# Already Done — Operator Guide

## Quick-start commands

```bash
# Run the research pipeline (stop at daily API limit, pick up tomorrow)
node scripts/run-pipeline.js

# Cron wrapper — runs at 8am daily, sends Pushbullet notifications, logs to logs/pipeline.log
# Already installed in crontab. To edit: crontab -e
# scripts/run-pipeline-cron.sh

# Once prospects accumulate: build template sites (3 at a time, ~1/min)
node scripts/run-site-builder.js

# Once sites are built: send outreach emails (10 at a time)
node scripts/run-outreach.js

# Target a specific city (useful for manual campaigns)
node scripts/run-pipeline.js --area Edinburgh

# Change daily API request cap (default 200)
node scripts/run-pipeline.js --daily-limit 150

# Nuclear reset — wipe all businesses, interactions, reset queue to pending
node scripts/clean-start.js
```

## Pipeline status check

```bash
# Full pipeline dashboard — stages, prospect counts, recent activity
node scripts/pipeline-status.js

# Database schema check — confirms all columns exist
node scripts/verify-db.js
```

## Deploy the marketing site

```bash
# Edit sites/alreadydone.uk/index.html then:
bash scripts/deploy-site.sh
# Pushes to GitHub + deploys to Cloudflare Pages in one step
```

---

## How the system works

The system finds UK small businesses with broken or missing websites, builds them a free demo site, then emails the owner offering to sell it for £99.

There are three sequential stages, each with its own agent and runner script.

---

### Stage 1 — Research (run-pipeline.js → research-agent.js)

**What it does:** Queries the Google Places API for every combination of business category and UK location, identifies which results are prospects, and stores everything in the database.

**The queue (`research_queue` table):** Seeded with 437 categories × 1,757 locations = ~767,000 combinations. Status starts `pending`, becomes `running` while being processed, then `complete`. The pipeline works through this queue in expansion order: Edinburgh first, then outward across Scotland and down through England and Wales.

**Expansion order (`seeds/expansion-order.js`):** Defines the city-by-city sweep sequence. The pipeline completes all pending categories for Edinburgh before moving to Musselburgh, then Dalkeith, etc. Cities that don't appear here still exist in the queue but won't be reached until all listed cities are done.

**Per-business logic (`research-agent.js → lib/parked.js`):**

1. Fetches up to 60 results per query (3 paginated API calls maximum).
2. Skips permanently closed businesses and national chains (`lib/chains.js`).
3. Checks each business's website status by:
   - DNS resolution (does the domain exist?)
   - HTTP fetch with browser headers (is there real content?)
   - Content analysis (live site, parked page, coming-soon, broken server, broken DNS, SEO doorway domain)
4. Classifies the lead:
   - `live` — working website, skip
   - `parked` — domain registered, parking page (Tier 1 — strongest lead)
   - `coming_soon` — started but never finished (Tier 1)
   - `broken_server` — DNS resolves, server down (Tier 2)
   - `broken` / `broken_dns` — various failure modes (Tier 3)
   - `none` — no website at all (Tier 3, cold — no email route)
   - `seo_doorway` — keyword-stuffed domain from an old SEO agency, not a real site (Tier 3)
5. Checks MX records on the domain (needed to route outreach emails).
6. Sets lead temperature: `hot` (MX present + strong need), `warm` (one condition missing), `cold` (no email route).
7. Saves everything to the `businesses` table with `pipeline_status = 'researched'`.

**API budget:** Google Places API Text Search Enterprise SKU costs £25.95/1,000 requests after the first 1,000/month free. The $200/month Google Maps credit (~£160) covers ~6,150 further requests. Safe total: ~238/day. Default limit: 200/day. Each queue item uses 1–3 actual HTTP requests (pagination), tracked accurately.

---

### Stage 2 — Site builder (run-site-builder.js → site-builder-agent.js)

**What it does:** Takes businesses with `pipeline_status = 'researched'` and generates a complete, self-contained single-page HTML website for each one using the Claude API.

**How sites are built (`lib/claude.js`):**

- Classifies the business into a sector profile (12 profiles: emergency trades, standard trades, food/hospitality, wellness, beauty, creative, professional, automotive, childcare, driving, events, local lifestyle, general).
- Each profile defines the tone, primary CTA, and an ordered list of sections tailored to that sector (e.g. an emergency trades site leads with a large phone number; a wellness site leads with a personal warm introduction).
- Picks a colour palette and layout variant deterministically from the business name hash, so the same business always gets the same design, but different businesses get visual variety.
- Sends to `claude-sonnet-4-6` with an 8,000-token output budget to generate a complete `<!DOCTYPE html>` page with all CSS embedded.
- Screenshots the resulting HTML via a headless browser (`lib/screenshot.js`) and saves the image path.
- Updates `pipeline_status` to `'template_built'`.

**Rate:** 3 sites per batch, one per minute (Anthropic Tier 1 output token limit).

---

### Stage 3 — Outreach (run-outreach.js → outreach-agent.js)

**What it does:** Takes businesses with `pipeline_status = 'template_built'` and sends a personalised cold email from Rougvie@alreadydone.uk offering to sell the demo site for £99.

**Per-business process:**

1. Skips `broken_dns` leads (MX records will also be gone — email will bounce).
2. Finds an email address for the domain (`lib/email-finder.js`): tries common patterns (hello@, info@, contact@, the business name@), falls back to scraping the website's contact page.
3. If no email found, marks the business `dropped` with reason `no_email_found`.
4. Generates a personalised email body via Claude using the business's situation as the hook:
   - Broken server: "your website is down and customers clicking your Google listing get an error"
   - Coming soon: "you started building a site but never finished it — I finished it for you"
   - Parked: "your domain just shows a placeholder — so I built a preview"
5. Attaches the screenshot of the demo site.
6. Sends via Amazon SES (`lib/mailer.js`) from Rougvie@alreadydone.uk.
7. Updates `pipeline_status` to `'emailed'`, logs the interaction.

**Email subjects** (rotated by business name length to avoid pattern detection):
- "I built a website for [Business Name]"
- "Quick one — I made a website for you"
- "[Business Name] — I built something for you"

**Rate:** 10 emails per batch, 2-second pause between sends.

---

## Database tables

| Table | Purpose |
|---|---|
| `research_queue` | All 767k category/location combinations. Tracks what has been scanned. |
| `businesses` | Every business found by the research agent, with all Places data and lead classification. |
| `interactions` | Append-only log of every event per business: research, site_built, email_sent, reply_received, error. |

**Pipeline status flow for a prospect:**

```
researched → template_built → emailed → [replied] → paid → delivered
                                       → dropped (broken_dns / no_email / not_interested)
```

---

## Environment variables (.env)

| Variable | Purpose |
|---|---|
| `GOOGLE_PLACES_API_KEY` | Google Cloud — Places API v1 (New) |
| `ANTHROPIC_API_KEY` | Claude API — site generation and email writing |
| `SUPABASE_URL` | Database URL |
| `SUPABASE_SERVICE_KEY` | Database service role key (bypasses RLS) |
| `SES_ACCESS_KEY_ID` | AWS SES — outbound email |
| `SES_SECRET_ACCESS_KEY` | AWS SES |
| `SES_REGION` | AWS region (e.g. `eu-west-1`) |
| `FROM_EMAIL` | Sending address (e.g. `Rougvie@alreadydone.uk`) |
| `BASE_PRICE_GBP` | Default offer price (default: `99`) |
| `DAILY_LIMIT` | Override API request cap |
| `DELAY_SECS` | Override delay between research rounds (default: `90`) |
| `MAX_RESULTS_PER_QUERY` | Max Places results per query (default: `60`) |

---

## Seed data

| File | Contents |
|---|---|
| `seeds/categories.js` | 437 business types queried against each location |
| `seeds/locations.js` | 1,757 UK locations (cities, towns, sub-areas, villages) |
| `seeds/expansion-order.js` | City priority order for the auto-mode pipeline |

To re-seed the queue after changing categories or locations:

```bash
node scripts/clean-start.js   # wipe businesses + reset queue (5s countdown)
node scripts/seed-queue.js    # insert new combinations
node scripts/verify-db.js     # confirm
```

---

## Cron job & notifications

The pipeline runs daily at 8am via cron. The wrapper script is `scripts/run-pipeline-cron.sh`.

**Pushbullet setup (⚠️ YOU need to do this):**
1. Go to pushbullet.com → Settings → Access Tokens → Create token
2. Add the token to `.env`: `PUSHBULLET_TOKEN=your_token_here`
3. Install the Pushbullet app on your phone to receive push notifications

Once set, you'll get three notifications per run:
- **Start** — "Research pipeline started at 08:00 on 2026-05-04"
- **End** — Time range, rounds completed, API calls used, new prospects found, stop reason

If `PUSHBULLET_TOKEN` is blank the wrapper still runs correctly — it just skips the notifications silently.

**Log files:**
- `logs/pipeline.log` — full output from every run, appended daily
- `logs/cron-errors.log` — any cron-level failures (script not found, permissions, etc.)

---

## ToDo

### Done ✓
- [x] Google Places research pipeline with daily API budget tracking
- [x] Domain status checker (parked, coming-soon, broken-server, broken-dns, live, seo-doorway)
- [x] Lead tier and temperature classification (hot / warm / cold)
- [x] National chain filter
- [x] Claude site builder with 12 sector profiles, 6 layouts, sector-matched palettes
- [x] Personalised cold email generator (hook varies by website status)
- [x] MX record check (determines whether email outreach is viable)
- [x] Supabase database with businesses, queue, and interactions tables
- [x] 437 business categories across all UK SME sectors
- [x] 1,757 UK locations with sub-area coverage for all major cities
- [x] Edinburgh-outward expansion order across all UK cities
- [x] API request tracking fixed to count actual HTTP calls (not queue items)
- [x] Cron job with Pushbullet start/end/stats notifications
- [x] HOW-TO operator guide
- [x] Amazon SES SMTP set up, DKIM/SPF/DMARC verified, production access requested
- [x] Domain moved to Cloudflare (nameservers updated at Ionos)
- [x] alreadydone.uk marketing site live at https://alreadydone.uk
- [x] Cloudflare Pages deploy pipeline (`bash scripts/deploy-site.sh`)
- [x] GitHub repo: github.com/alreadydoneuk/alreadydone-site (ops@alreadydone.uk account)
- [x] Email routing: dean@, ops@, finance@, legal@, support@ all forward to drougvie@gmail.com
- [x] TEST_EMAIL safety guard — all outreach redirected to Gmail during testing
- [x] Preview sites published to alreadydone.uk/preview/{slug} on every site build
- [x] Claim banner injected on every preview page (Claim it for £99 → pre-fills email to Dean)
- [x] Real Google rating/review count shown as trust badge on generated sites
- [x] Lorem Ipsum testimonials (no fabricated names or endorsements)
- [x] Price anchoring + risk reversal added to email copy
- [x] Reply monitor agent (`agents/reply-monitor-agent.js`) — classifies inbound replies via Claude
- [x] Follow-up agent (`agents/follow-up-agent.js`) — re-emails after FOLLOW_UP_DELAY_DAYS, drops after NO_REPLY_TIMEOUT_DAYS
- [x] Cost tracking: ~$0.12/site generated (8k output tokens)

---

### Needs your decision or action ⚠️

- [ ] **SES production access** — submitted to AWS, awaiting approval (24–48h). Until approved, can only send to verified addresses. Check AWS Console → SES → Account dashboard (EU Ireland region).
- [ ] **Reply monitoring inbox** — `agents/reply-monitor-agent.js` is built but needs IMAP credentials. Options: (a) set up SES inbound → forward to a Gmail/Outlook account, or (b) add a monitored Gmail with IMAP enabled. Set `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` in `.env`.
- [ ] **Testimonials** — currently using Lorem Ipsum. Decide: keep as placeholder, pull real Google reviews via Places API (up to 5 per business), or remove section entirely until real reviews exist.
- [ ] **Price point** — currently £99. Decide if fixed or tiered: £79 cold / £99 warm / £149 hot?
- [ ] **Payment flow** — when a prospect replies "yes" there is no payment link or delivery workflow. Decide: (a) manual Stripe link sent by Dean on positive reply, or (b) automated Stripe link triggered by `replied_positive` status. Delivery: hand over HTML file, or host it for them on a subdomain?
- [ ] **Formspree** — contact form on alreadydone.uk points to placeholder. Set up a real Formspree form or replace with a mailto: link.

---

### Integrations to connect ⚠️

- [ ] **Notion** — connect Claude to Notion so system specs, guides, pipeline status, and decisions can be maintained automatically as a live document rather than flat files. Needs a Notion integration token + shared database/page.
- [ ] **Slack** — replace Pushbullet with Slack for richer notifications (formatted messages, reply threads, channels per topic: #pipeline, #leads, #revenue). Needs a Slack workspace + bot token + incoming webhook. Enables: positive reply alerts with prospect details, daily stats digests, payment confirmations.

---

### Code to build next 🔧

- [ ] **Payment + delivery flow** — on `replied_positive`: generate Stripe payment link, send to prospect. On payment confirmed: update to `paid` → deploy site to their subdomain or hand over HTML → update to `delivered`
- [ ] **Stripe webhook handler** — listen for `payment_intent.succeeded`, trigger delivery automatically
- [ ] **Live preview click tracking** — Cloudflare Workers KV to log when a preview URL is visited, push Pushbullet alert when a prospect opens their preview. High-value signal of intent.
- [ ] **Dashboard / stats view** — terminal script or simple web page showing: prospects by city, pipeline stage breakdown, emails sent today, conversion rate, revenue
- [ ] **Warm lead enrichment** — Companies House (confirm active), social presence check. Feeds better personalisation.
- [ ] **Found Local directory** — separate public-facing site publishing the business data. Separate project, not yet started.
- [ ] **Reverify agent** — `scripts/reverify-businesses.js` exists but not wired into cron yet

### Conversion improvements identified 💡

- [ ] **Preview click tracking** — know when a prospect views their site. Cloudflare Workers + KV, no extra cost
- [ ] **Real Google reviews** — Places API returns up to 5 reviews per business. Use these instead of Lorem Ipsum where available
- [ ] **Dean's phone number** — add to `.env` as `DEAN_PHONE`. Show in claim banner as alternative to email. Reduces friction for phone-preferring trades
- [ ] **Urgency email variant** — A/B test a subject line variant that references the 14-day expiry: "Your website preview expires [date]"
- [ ] **Subdomain delivery** — when a business pays, move their site from preview/ to a named subdomain (e.g. garlands.alreadydone.uk) as a value-add before they migrate to their own domain
