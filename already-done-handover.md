# Already Done — Project Handover
**For:** Claude Code CLI  
**Project:** Already Done (AlreadyDone.co.uk)  
**Purpose:** Fully automated pipeline — UK small business website generation, outreach, payment, and delivery  
**Owner:** Rougvie  
**Date:** May 2026

---

## Project Vision

Already Done is a fully automated revenue pipeline. It finds UK small businesses without a working website, builds them a professional one-page site, emails them a screenshot with a £99 purchase offer, handles follow-up, invoicing, payment collection, and site delivery — with zero manual intervention required in the standard flow.

The only time the owner (Rougvie) should need to intervene is when something breaks.

---

## Core Principles

- **Nothing in the standard pipeline requires manual action**
- **No deliverable is handed over before payment clears**
- **Costs are minimised at every stage** — expensive API calls only happen after a positive signal
- **Every interaction is logged** — for pipeline refinement, tax, and P&L
- **The email personality is human and warm** — small business owner to small business owner, not a corporate tool
- **Quality of generated sites must be high** — the Already Done website itself is the portfolio

---

## Pipeline Overview

```
RESEARCH
  Queue table (category + location combinations) 
  → Google Places API (Essentials tier, field masked)
  → Website check (HTTP HEAD request)
  → Tier and score each business
  → Write to businesses table

          ↓

TEMPLATE BUILD (cheap)
  Pull basic data only (name, category, location, address)
  → Claude generates one-page HTML site with placeholders
  → Lorem ipsum where reviews would go
  → Stock image if no photos available
  → Deploy to Vercel/Netlify subdomain (alreadydone.co.uk/preview/[slug])
  → Playwright screenshot

          ↓

OUTREACH EMAIL
  Claude writes personalised cold email
  → Warm, human tone (see Email Personality section)
  → Includes screenshot inline
  → Includes domain availability suggestions
  → Sent via Resend API
  → Interaction logged to database

          ↓

REPLY MONITORING
  Poll inbox / webhook for replies
  → Claude classifies reply: positive / negative / neutral / no_reply
  → drop_reason classified if negative
  → Route accordingly

    YES ──────────────────────────────────────────────┐
                                                       ↓
                                              FULL ENRICHMENT
                                              Google Places Pro/Enterprise tier
                                              → Real reviews, photos, contact
                                              → Claude rebuilds full site
                                              → Real screenshot generated
                                              → Stripe invoice created (£99)
                                              → Email: real screenshot + payment link
                                              → Monitor for payment webhook

                                                       ↓ PAYMENT CLEARS

                                              DELIVERY
                                              → Zip site files
                                              → Generate plain English setup guide
                                              → Include domain suggestions + affiliate links
                                              → Include upsell options (setup, maintenance)
                                              → Send delivery email
                                              → Mark pipeline_status = delivered
                                              → Log to finance table

    NO / NO REPLY ────────────────────────────────────┐
                                                       ↓
                                              FOLLOW-UP (one attempt only)
                                              → Claude writes follow-up email
                                              → Wait X days
                                              → If still no: delete deployment
                                              → Mark dropped_at_stage + drop_reason
```

---

## Tech Stack

| Layer | Tool | Notes |
|---|---|---|
| Runtime | Node.js | All agents are Node scripts |
| Database | Supabase (Postgres) | Free tier sufficient initially |
| Business discovery | Google Places API | Field masked, Essentials tier for filtering |
| HTTP checking | Axios | HEAD requests to detect parked/broken sites |
| Site generation | Claude API (claude-sonnet-4-20250514) | Generates HTML/CSS one-pagers |
| Site deployment | Vercel CLI or Netlify CLI | Subdomain per business |
| Screenshots | Playwright | Headless Chromium |
| Domain lookup | Namecheap API | Check availability, generate affiliate links |
| Email sending | Resend | Transactional, good deliverability |
| Reply monitoring | Gmail API or Resend webhooks | Inbound reply classification |
| Reply classification | Claude API | Sentiment + drop_reason extraction |
| Payments | Stripe | Webhooks trigger delivery |
| Scheduling | Node cron (node-cron) | Runs agents on schedule |
| Finance tracking | Supabase finance table | P&L, tax-ready exports |

---

## Database Schema

### Table: `queue`
The agent's work list. Seeded once, worked through automatically.

```sql
CREATE TABLE queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  region TEXT,
  population_tier TEXT, -- 'city' | 'town' | 'village'
  status TEXT DEFAULT 'pending', -- 'pending' | 'running' | 'complete'
  last_run_at TIMESTAMPTZ,
  times_run INT DEFAULT 0,
  businesses_found INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Seed with ~40 categories × ~1,500 UK towns/cities = ~60,000 combinations.
Agent picks next `status = 'pending'` row, marks it `running`, processes, marks `complete`.

### Table: `businesses`
One row per business. The full pipeline state lives here.

```sql
CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Identity
  name TEXT NOT NULL,
  category TEXT,
  location TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  domain TEXT,
  place_id TEXT UNIQUE, -- Google Place ID
  
  -- Research
  website_status TEXT, -- 'none' | 'parked' | 'broken' | 'live'
  tier INT,            -- 1 = parked domain | 2 = email only | 0 = skip
  google_rating NUMERIC(2,1),
  review_count INT,
  
  -- Generated site
  template_url TEXT,       -- Vercel/Netlify preview URL
  template_screenshot TEXT, -- path or URL to screenshot
  full_site_url TEXT,
  full_site_screenshot TEXT,
  site_slug TEXT,          -- unique slug for deployment
  
  -- Pipeline state
  pipeline_status TEXT DEFAULT 'researched',
  -- Values: researched | template_built | emailed | follow_up_sent |
  --         enriched | invoiced | paid | delivered | dropped
  
  dropped_at_stage TEXT,   -- which stage they exited
  
  -- Email tracking
  first_email_sent_at TIMESTAMPTZ,
  first_email_opened BOOLEAN DEFAULT FALSE,
  follow_up_sent_at TIMESTAMPTZ,
  last_reply_at TIMESTAMPTZ,
  reply_count INT DEFAULT 0,
  
  -- Response classification
  response_sentiment TEXT, -- 'positive' | 'negative' | 'neutral' | 'no_reply'
  drop_reason TEXT,
  -- Values: price_too_high | angry | not_interested | no_reply |
  --         already_has_site | wrong_contact | bounced | other
  drop_reason_notes TEXT,  -- Claude's summary of the actual reply
  
  -- Domain suggestions
  domain_suggestions JSONB, -- array of {domain, available, price, affiliate_url}
  
  -- Commercial
  stripe_invoice_id TEXT,
  invoice_sent_at TIMESTAMPTZ,
  invoice_amount NUMERIC(8,2) DEFAULT 99.00,
  paid_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  
  -- Upsell
  upsell_offered BOOLEAN DEFAULT FALSE,
  upsell_accepted BOOLEAN DEFAULT FALSE,
  upsell_tier TEXT,  -- 'setup' | 'maintenance' | 'both'
  upsell_value NUMERIC(8,2),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Table: `interactions`
Full audit trail of every touchpoint per business.

```sql
CREATE TABLE interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id),
  type TEXT NOT NULL,
  -- Values: email_sent | reply_received | follow_up_sent | 
  --         invoice_sent | payment_received | site_delivered |
  --         classification | error
  direction TEXT, -- 'inbound' | 'outbound' | 'internal'
  content_summary TEXT,  -- Claude's one-line summary
  raw_content TEXT,      -- full email body or event data
  metadata JSONB,        -- flexible: stripe event, email headers, etc
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Table: `finance`
Every money movement across all side gigs (built to be shared).

```sql
CREATE TABLE finance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT DEFAULT 'already_done', -- future-proofed for multiple gigs
  business_id UUID REFERENCES businesses(id),
  type TEXT NOT NULL, -- 'revenue' | 'cost'
  category TEXT,
  -- Revenue: site_sale | upsell_setup | upsell_maintenance | affiliate
  -- Cost: api_google | api_claude | api_resend | hosting | stripe_fee | domain
  amount NUMERIC(8,2) NOT NULL,
  currency TEXT DEFAULT 'GBP',
  description TEXT,
  stripe_payment_id TEXT,
  tax_year TEXT,   -- e.g. '2025-26'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Agent Descriptions

### 1. `research-agent.js`
**Trigger:** Cron schedule (e.g. every 2 hours)  
**What it does:**
- Picks next pending queue item
- Calls Google Places Text Search with field mask: `name,id,websiteUri`
- For each result with a website: HEAD request to check if real/parked/broken
- For each result without a website: check if email is available in profile
- Tiers results (1/2/skip)
- Writes qualified businesses to `businesses` table
- Marks queue item complete

**Key environment variables:**
```
GOOGLE_PLACES_API_KEY
SUPABASE_URL
SUPABASE_SERVICE_KEY
MAX_RESULTS_PER_RUN=50
```

---

### 2. `site-builder-agent.js`
**Trigger:** Cron schedule, picks businesses where `pipeline_status = 'researched'`  
**What it does:**
- Pulls basic business data (no expensive API calls yet)
- Calls Claude API with a detailed prompt to generate a full HTML/CSS one-pager
- Template uses placeholders: "[REVIEWS WILL APPEAR HERE]", lorem intro text
- Selects visual style based on category (see Style Guide below)
- Deploys to Vercel via CLI
- Takes Playwright screenshot
- Updates business record: `template_url`, `template_screenshot`, `pipeline_status = 'template_built'`

**Claude prompt structure:**
```
System: You are an expert web designer generating beautiful, 
        modern single-page websites for UK small businesses.
        Output only valid HTML with embedded CSS. No markdown.
        
User:   Business name: [name]
        Category: [category]
        Location: [location]
        Address: [address]
        Style: [selected from category mapping]
        Placeholder mode: true
        ...
```

---

### 3. `outreach-agent.js`
**Trigger:** Cron, picks `pipeline_status = 'template_built'`  
**What it does:**
- Checks domain availability via Namecheap API
- Calls Claude to write personalised cold email (see Email Personality)
- Sends via Resend with screenshot inline
- Logs to `interactions` table
- Updates `pipeline_status = 'emailed'`

---

### 4. `reply-monitor-agent.js`
**Trigger:** Cron every 30 minutes  
**What it does:**
- Polls for new email replies
- Sends each reply to Claude for classification
- Claude returns: `{ sentiment, drop_reason, drop_reason_notes, recommended_action }`
- Routes: positive → enrich-agent | negative → follow-up or drop | no reply after X days → follow-up

---

### 5. `enrich-agent.js`
**Trigger:** Called when reply classified as positive  
**What it does:**
- Calls Google Places API with full field mask (Pro/Enterprise tier)
- Pulls real reviews, photos, contact details
- Calls Claude to regenerate full site with real content
- Redeploys to Vercel
- Takes new screenshot
- Creates Stripe invoice (£99)
- Sends email with real screenshot + payment link
- Updates `pipeline_status = 'invoiced'`

---

### 6. `payment-monitor-agent.js`
**Trigger:** Stripe webhook (`payment_intent.succeeded`)  
**What it does:**
- Confirms payment matches a business record
- Triggers delivery
- Logs to `finance` table
- Updates `pipeline_status = 'paid'`

---

### 7. `delivery-agent.js`
**Trigger:** Called by payment-monitor on payment confirmation  
**What it does:**
- Zips site files
- Generates plain English setup guide (Claude writes this)
- Includes domain affiliate links from earlier lookup
- Includes upsell options (setup service, maintenance package)
- Sends delivery email
- Updates `pipeline_status = 'delivered'`

---

### 8. `finance-agent.js`
**Trigger:** Called by any agent that moves money  
**What it does:**
- Writes every transaction to `finance` table
- Tracks: revenue, Stripe fees, API costs, hosting costs
- Available via CLI command to print P&L summary
- Exports tax-year summaries as CSV

---

## Email Personality

Every outbound email is written by Claude using this brief. It must feel like it was written by a real person, not a tool.

**Voice:** Warm, direct, entrepreneurial. Small business owner to small business owner.

**Core framing:** "I was looking for local businesses to work with. I found yours. I noticed you didn't have a website. Rather than just pitch you, I built one. Here it is."

**Tone rules:**
- First person throughout
- No bullet points or corporate formatting
- Short paragraphs, conversational
- Confident about quality, not arrogant
- Honest about why this is being sent
- Sign off as a person, not a brand

**Sample opening (Claude should use this as a style guide, not copy it verbatim):**
> "Hi [Name], I'm just getting started building websites for small businesses and I've been spending time finding local businesses I think I could genuinely help. I came across [Business Name] while looking around [location] and noticed you didn't have your own website yet. Rather than just send a message saying I could build one, I thought I'd show you — so I did."

**What to include:**
1. Who I am and why I'm writing
2. What I noticed (no website / parked domain)
3. What I did (built a preview — screenshot attached)
4. The offer (£99, straightforward)
5. Domain angle: "I also had a quick look and found a few domain names that would suit you perfectly — happy to share those"
6. No-pressure close

**What to avoid:**
- "Dear Sir/Madam"
- Claiming to be a large agency
- Overpromising
- Listing features with bullet points
- Apologetic language

---

## Site Style Guide

Sites should feel tailored to the business type. Claude should select one of these visual approaches based on category:

| Category type | Style |
|---|---|
| Food & hospitality | Warm, rich colours, large food/atmosphere imagery |
| Trades (plumber, electrician, builder) | Clean, trustworthy, navy/white, bold CTA |
| Health & beauty (groomer, salon, physio) | Soft, modern, pastel or neutral, elegant typography |
| Professional services | Minimal, serif headings, white space, authoritative |
| Leisure & fitness | Energetic, bold type, strong contrast |
| Retail | Friendly, colourful, product-forward |

**All sites must include:**
- Hero section with business name and one-line description
- About section (2-3 sentences, warm tone)
- Reviews/testimonials section (placeholder or real)
- Contact section with address and phone
- Google Maps embed (placeholder iframe in template mode)
- Clear call to action (phone number or email, prominent)
- Mobile responsive

**All sites must NOT include:**
- Stock photography that looks obviously generic
- Lorem ipsum in the delivered (paid) version
- Cluttered layouts
- More than 2-3 fonts
- Anything that looks like a template

---

## Already Done Website (alreadydone.co.uk)

This is the credibility layer. Every cold email recipient will check it.

**Required pages:**
- **Homepage** — Hero, how it works (3 steps), pricing tiers, live examples, trust signals
- **Examples** — Gallery of generated sites across categories, each linking to live demo
- **Pricing** — Clear tier ladder (see below)
- **FAQ** — Answers the obvious objections

**Pricing tiers to display:**

| Tier | Price | What's included |
|---|---|---|
| Starter | £99 | One-page site, zip + setup instructions |
| Expanded | £199 | Multi-section single page, gallery, more content |
| Full site | £299 | Multi-page (Home / About / Services / Contact) |
| Maintenance | £X/mo | Content updates, review refresh, hosting managed |

**Before launching the pipeline, build 5-6 demo sites manually** across different categories to populate the Examples page. These are also the test bed for the site generator.

---

## Domain & Affiliate Strategy

**Domain lookup:** Use Namecheap API to check availability of 3-5 domain variations per business.

Generation logic:
```
Input: "Tails & Trails Dog Grooming, Shrewsbury"
Candidates:
  tailsandtrails.co.uk
  tailsandtrailsgrooming.co.uk  
  tailstrails.co.uk
  tailsgrooming.co.uk
```

Prioritise `.co.uk` — carries local trust with UK small businesses.

**Affiliate programmes to integrate:**
- Namecheap Affiliate (~35% commission on first purchase)
- IONOS Affiliate (higher commissions on hosting packages)
- Google Workspace Referral (professional email upsell)

All domain suggestions in emails and delivery packs should use affiliate links.

---

## Environment Variables (full list)

```env
# Google
GOOGLE_PLACES_API_KEY=

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# Claude
ANTHROPIC_API_KEY=

# Resend (email)
RESEND_API_KEY=
FROM_EMAIL=hello@alreadydone.co.uk
REPLY_TO_EMAIL=hello@alreadydone.co.uk

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Vercel
VERCEL_TOKEN=
VERCEL_TEAM_ID=
VERCEL_PROJECT_ID=

# Namecheap
NAMECHEAP_API_KEY=
NAMECHEAP_USERNAME=
NAMECHEAP_CLIENT_IP=

# Pipeline config
MAX_RESULTS_PER_RUN=50
FOLLOW_UP_DELAY_DAYS=5
NO_REPLY_TIMEOUT_DAYS=14
BASE_PRICE_GBP=99
```

---

## File Structure

```
already-done/
├── agents/
│   ├── research-agent.js
│   ├── site-builder-agent.js
│   ├── outreach-agent.js
│   ├── reply-monitor-agent.js
│   ├── enrich-agent.js
│   ├── payment-monitor-agent.js
│   ├── delivery-agent.js
│   └── finance-agent.js
├── lib/
│   ├── supabase.js          # DB client + helper queries
│   ├── places.js            # Google Places API wrapper
│   ├── claude.js            # Anthropic API wrapper
│   ├── resend.js            # Email sending
│   ├── stripe.js            # Payment helpers
│   ├── vercel.js            # Deploy + screenshot
│   ├── namecheap.js         # Domain lookup + affiliate links
│   └── classifier.js        # Reply classification helpers
├── prompts/
│   ├── site-template.js     # Claude prompt for site generation
│   ├── site-full.js         # Claude prompt for enriched site
│   ├── cold-email.js        # Claude prompt for outreach email
│   ├── follow-up-email.js   # Claude prompt for follow-up
│   ├── delivery-email.js    # Claude prompt for delivery email
│   └── reply-classifier.js  # Claude prompt for reply classification
├── seeds/
│   ├── categories.js        # ~40 UK business categories
│   └── locations.js         # ~1,500 UK towns and cities
├── scripts/
│   ├── seed-queue.js        # One-time: populate queue table
│   ├── pnl-report.js        # Print P&L to console
│   └── export-tax.js        # Export finance table as CSV
├── webhooks/
│   └── stripe.js            # Express endpoint for Stripe events
├── scheduler.js             # node-cron: wires all agents to schedules
├── .env
└── package.json
```

---

## Build Order

Build in this sequence. Each step is independently testable before moving to the next.

1. **Set up infrastructure**
   - Google Cloud project, enable Places API, get key
   - Supabase project, run schema SQL
   - Vercel account + CLI authenticated
   - Resend account, verify sending domain
   - Stripe account, get keys, set up webhook endpoint

2. **Seed the queue**
   - Write `seeds/categories.js` and `seeds/locations.js`
   - Run `seed-queue.js` to populate ~60,000 combinations

3. **Build and test research-agent.js**
   - Test against one category + location
   - Verify results appear in Supabase
   - Check tiering logic is working

4. **Build and test site-builder-agent.js**
   - Generate 5-6 demo sites manually first to establish quality bar
   - Then automate, test against a real business record
   - Verify screenshot looks good

5. **Build the Already Done website**
   - Use demo sites as portfolio examples
   - Must be live before outreach begins

6. **Build and test outreach-agent.js**
   - Test email rendering and deliverability
   - Verify interactions table is logging correctly

7. **Build reply-monitor-agent.js + classifier**
   - Test classification against sample replies

8. **Build enrich-agent.js**
   - Test full enrichment against a positive test case

9. **Build payment flow**
   - Stripe invoice creation
   - Webhook receiver
   - payment-monitor-agent.js

10. **Build delivery-agent.js**
    - Test full end-to-end with a dummy business

11. **Wire scheduler.js**
    - Connect all agents to cron schedules
    - Run full pipeline end-to-end test

12. **Launch**

---

## Key Decisions Already Made

- **Email only** — no SMS, no physical mail
- **No deliverable before payment** — site files sent only after Stripe confirms
- **Two-stage API calls** — cheap filter first, expensive enrichment only on positive reply
- **One follow-up only** — then delete and move on
- **£99 entry price** — with upsell ladder at delivery
- **Affiliate links** — Namecheap, IONOS, Google Workspace
- **Brand name** — Already Done (working title)
- **Email tone** — human, warm, small business to small business
- **Finance table** — shared infrastructure, project-tagged, tax-ready

---

## Open Items

- [ ] Confirm AlreadyDone.co.uk domain availability and register
- [ ] Decide sending email address format (hello@ vs jamie@ vs a persona name)
- [ ] Decide on maintenance pricing tier (monthly amount)
- [ ] Choose 5-6 demo business categories for initial portfolio sites
- [ ] Decide on Vercel vs Netlify for deployment (Vercel preferred — better CLI)
- [ ] Set follow-up delay days and no-reply timeout (suggested: 5 days / 14 days)
