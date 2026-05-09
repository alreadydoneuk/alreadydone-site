# Already Done — System Report
Generated: 2026-05-05

---

## What Was Built Last Night

### Preview Site Infrastructure
- Every generated business site is now published live at alreadydone.uk/preview/{slug}
- A sticky claim banner is injected at the top of every preview page showing the business name, a "Claim it for £99 →" button (pre-fills an email to dean@alreadydone.uk with subject and body), and a countdown: "Preview available until [date + 14 days]"
- The screenshot (used in the outreach email) is taken from a clean copy without the banner — so the email shows a professional site, and the banner only appears when the prospect clicks through
- Deploy is one command: bash scripts/deploy-site.sh — pushes to GitHub and Cloudflare Pages simultaneously

### Email Quality Improvements
- Price anchoring added: "most agencies charge £1,000–£2,000+ for a site like this"
- Risk reversal added: "no obligation — if you're not interested, ignore this and the preview comes down in two weeks"
- Real Google rating is now shown as a trust badge on the generated site (e.g. ★ 4.8/5 · 47 Google Reviews) using actual Places API data
- Testimonials now use Lorem Ipsum placeholder text — no fabricated named reviews
- Email prompt now references Google review count as a hook: "You have 47 people vouching for you on Google — but without a working website that reputation isn't converting new customers"

### New Agents Built
- reply-monitor-agent.js — polls an IMAP inbox, matches replies to businesses by sender domain, classifies sentiment (positive/negative/neutral) using Claude, updates pipeline status, sends Pushbullet alert on positive replies. Needs IMAP credentials in .env to activate.
- follow-up-agent.js — automatically re-emails no-reply prospects after FOLLOW_UP_DELAY_DAYS (default: 5), drops them with reason "no_reply_timeout" after NO_REPLY_TIMEOUT_DAYS (default: 14). Runs daily via cron.

### Pipeline Improvements
- Hot leads now prioritised over warm in site builder queue (two separate DB fetches, hot first)
- broken_dns leads excluded from site building (no email route, no point spending API budget)
- Site builder now runs 3 sites automatically every day via cron — no manual trigger needed
- Cost tracking added: every site build logs token usage and dollar cost (~$0.12/site)
- TEST_EMAIL safety guard: all outreach redirects to drougvie@gmail.com when set — prevents accidental cold emails during testing

### New Scripts
- node scripts/pipeline-status.js — live dashboard showing: queue progress, total/prospect counts by temperature, pipeline stage breakdown, recent activity log
- node scripts/run-reply-monitor.js — manual trigger for reply check
- node scripts/run-follow-up.js — manual trigger for follow-ups

### GitHub / Deploy
- GitHub account created: alreadydoneuk (ops@alreadydone.uk)
- Repo: github.com/alreadydoneuk/alreadydone-site
- Marketing site and all preview sites live in this repo
- Every deploy: git commit → git push → Wrangler → Cloudflare Pages

---

## What the System Can Now Do Autonomously (Daily, 8am Cron)

1. Check IMAP inbox for replies → classify sentiment → update pipeline → Pushbullet alert on positive
2. Send follow-up emails to no-reply prospects past the 5-day window
3. Drop prospects with no reply after 14 days
4. Run the Google Places research pipeline (up to 200 API calls/day, Edinburgh outward)
5. Build 3 preview sites for the hottest unbuilt prospects → publish to alreadydone.uk/preview/
6. Send Pushbullet start/end notifications with daily stats

What still requires manual action:
- node scripts/run-outreach.js — outreach is intentionally manual until SES production access is confirmed and TEST_EMAIL is removed
- Payment: no Stripe integration yet — positive replies need a manual payment link sent by Dean
- Reply monitor: needs IMAP credentials configured before it activates

---

## Connected Services

### Google Cloud
- Service: Places API v1 (Text Search, New)
- Used for: Finding UK small businesses by category and location, fetching business details (name, address, phone, website, Google rating, review count, hours, photos)
- Billing: $200/month free credit (~6,150 requests after first 1,000 free). Daily cap set to 200 requests.
- Key: GOOGLE_PLACES_API_KEY in .env

### Anthropic (Claude API)
- Model: claude-sonnet-4-6
- Used for: (1) Generating single-page HTML sites (~$0.12/site, ~8k output tokens), (2) Writing personalised outreach emails (~$0.003/email), (3) Writing follow-up emails, (4) Classifying inbound replies (positive/negative/neutral)
- Balance: ~$18.70 → ~155 sites remaining
- Key: ANTHROPIC_API_KEY in .env

### Supabase (PostgreSQL)
- Used for: All persistent data storage
- Tables: businesses (all found businesses + pipeline state), queue (767k category/location combinations for research), interactions (append-only event log)
- URL: svscbaomnmzumzzswvfq.supabase.co
- Keys: SUPABASE_URL, SUPABASE_SERVICE_KEY in .env

### Amazon SES (Email)
- Region: eu-west-1 (Ireland)
- Used for: Sending outreach emails from dean@alreadydone.uk via SMTP
- Status: Domain verified (DKIM SUCCESS), production access submitted — awaiting AWS approval (24–48h). Currently sandbox mode (can only email verified addresses).
- IAM user: alreadydone-ses-smtp
- Keys: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL, FROM_NAME in .env

### Cloudflare
- Account: alreadydone.uk zone
- Used for:
  - DNS management (all records for alreadydone.uk)
  - Cloudflare Pages: hosts alreadydone.uk (marketing site) + alreadydone.uk/preview/* (all prospect preview sites)
  - Email Routing: dean@, ops@, finance@, legal@, support@ all forward to drougvie@gmail.com
- Project name: alreadydone-uk
- Keys: CLOUDFLARE_TOKEN, CLOUDFLARE_ZONE_ID in .env

### GitHub
- Account: alreadydoneuk (ops@alreadydone.uk)
- Repo: github.com/alreadydoneuk/alreadydone-site
- Used for: Version control for the marketing site + all preview sites. Every deploy commits here first.
- Token stored in git remote URL (local machine only)

### Pushbullet
- Used for: Mobile push notifications — pipeline start/end/stats, positive reply alerts
- Token: PUSHBULLET_TOKEN in .env

### Playwright (local)
- Used for: Headless Chromium screenshots of generated sites (the image attached to outreach emails)
- Runs locally on this machine, no external service

### Domain Registrar (Ionos)
- alreadydone.uk registered here
- Nameservers now point to Cloudflare (salvador.ns.cloudflare.com / sky.ns.cloudflare.com)
- DNS is managed entirely in Cloudflare — Ionos is just the registrar

---

## Full Pipeline Spec

### Stage 1 — Research
Script: node scripts/run-pipeline.js
Agent: agents/research-agent.js

Queries Google Places API for every combination of 437 business categories × 1,757 UK locations (767,809 queue items). For each business found:
- Checks domain status (DNS, HTTP, content analysis) → classified as: live, parked, coming_soon, broken_server, broken, broken_dns, seo_doorway, none
- Checks MX records (needed to send email)
- Classifies lead: hot (MX present + strong need), warm (one condition missing), cold (no email route)
- Skips national chains (lib/chains.js) and permanently closed businesses
- Saves to businesses table with pipeline_status = researched

Cost: Google Places API — ~200 requests/day (~£1.30/day after free tier)
Progress: Edinburgh area ~complete, expanding outward across Scotland

### Stage 2 — Site Builder
Script: node scripts/run-site-builder.js
Agent: agents/site-builder-agent.js

Takes hot/warm businesses with pipeline_status = researched. For each:
- Classifies into one of 12 sector profiles (emergency trades, wellness, food/hospitality, beauty, etc.)
- Picks colour palette, layout, and font deterministically from business name hash
- Generates full single-page HTML via Claude (8k tokens, ~$0.12/site)
- Shows real Google rating as trust badge if available
- Uses Lorem Ipsum for testimonials (no fabricated endorsements)
- Takes Playwright screenshot (clean, no banner)
- Writes preview copy to sites/alreadydone.uk/preview/{slug}/index.html with claim banner injected
- Deploys to Cloudflare Pages via bash scripts/deploy-site.sh
- Updates pipeline_status = template_built, stores preview_url

Rate: 3 sites per cron run (70s between each, Anthropic Tier 1 rate limit)

### Stage 3 — Outreach
Script: node scripts/run-outreach.js (manual — not in cron)
Agent: agents/outreach-agent.js

Takes businesses with pipeline_status = template_built. For each:
- Skips broken_dns
- Finds email address (tries common patterns: hello@, info@, contact@, businessname@; falls back to scraping contact page)
- Generates personalised email body via Claude using website status as hook:
  - broken_server: "your site is down and customers are getting an error"
  - coming_soon: "you started but never finished — I finished it for you"
  - parked/broken: "your domain just shows a placeholder — I built a preview"
- Adds price anchor (£99 vs £1,000–£2,000 agency alternative) and risk reversal
- Uses Google review count as hook if available
- Sends via SES: plain text + inline screenshot + "View your website →" button linking to preview URL
- Updates pipeline_status = emailed

TEST_EMAIL guard: while TEST_EMAIL is set in .env, all emails redirect to drougvie@gmail.com

### Stage 4 — Follow-up (automated)
Script: node scripts/run-follow-up.js (runs daily via cron)
Agent: agents/follow-up-agent.js

- After FOLLOW_UP_DELAY_DAYS (default: 5) with no reply: sends one follow-up email (softer, briefer)
- After NO_REPLY_TIMEOUT_DAYS (default: 14): drops business with reason no_reply_timeout
- Updates pipeline_status = follow_up_sent → dropped

### Stage 5 — Reply Monitor (automated, needs IMAP config)
Script: node scripts/run-reply-monitor.js (runs daily via cron)
Agent: agents/reply-monitor-agent.js

- Polls IMAP inbox for unseen messages
- Matches sender domain to emailed businesses
- Classifies via Claude: positive / negative / neutral
- Updates pipeline_status = replied_positive / replied_negative / replied_neutral
- Sends Pushbullet alert on positive reply
- Needs: IMAP_HOST, IMAP_USER, IMAP_PASS in .env

### Stage 6 — Payment + Delivery (not yet built)
On replied_positive: manually send Stripe payment link for £99
On payment confirmed: deliver HTML file or host on subdomain
Update pipeline_status: paid → delivered

---

## Pipeline Status Counts (as of 2026-05-05 ~04:00)

- Total businesses in DB: 2,223
- Prospects: 421 (19%)
  - Hot: 39 | Warm: 40 | Cold: 341
- Researched (awaiting site build): 415
- Sites built: 10 (live at alreadydone.uk/preview/)
- Emailed: 3 (test, to drougvie@gmail.com)
- Queue progress: Edinburgh area complete, ~767k combinations remaining

---

## Immediate Next Steps (requires your action)

1. AWS SES production access — check email for approval (submitted last night)
2. Remove TEST_EMAIL from .env when ready to send to real prospects
3. Run node scripts/run-outreach.js to email the 10 built sites (currently goes to Gmail for review)
4. Configure IMAP in .env to activate the reply monitor
5. Set up Stripe account for payment collection
6. Formspree — wire up the contact form on alreadydone.uk
