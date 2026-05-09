# Prospect Onboarding Flow
## From payment confirmed → customer live and notified

---

## Overview

Two emails. Nothing lands in their inbox until it is actually ready.

1. **Email 1 — "We're on it"** — sent within 30 seconds of Stripe payment confirmation
2. **Email 2 — "You're live"** — sent only after site and email are confirmed working

The customer must not be able to click a broken link. Email 2 is withheld until
a live HTTP check against their domain returns 200.

---

## Trigger

Stripe webhook: `payment_intent.succeeded` or `checkout.session.completed`

Payload must contain (captured at checkout):
- `customer_email` — their personal email (where both emails go)
- `domain` — the domain they chose (e.g. `joesplumbing.co.uk`)
- `email_prefix` — the mailbox name they chose (e.g. `joe`) — null if not selected
- `business_name` — used to generate the site
- `plan` — `site_only` | `site_and_email`

---

## Step-by-step

### On payment confirmed (run immediately, ~4 min total)

1. **Send Email 1** (< 30s after webhook)
2. **Register domain** — Porkbun `/domain/create/{domain}`, cost from prior availability check
3. **Set site DNS** — CNAME `@` + `www` → `ofcourseitwentwrong.pages.dev` (Cloudflare Pages)
4. **Generate site HTML** — Claude site-builder-agent (~90s)
5. **Create Cloudflare Pages project** — `POST /accounts/{id}/pages/projects`
6. **Deploy site** — `wrangler pages deploy _site --project-name={slug}`
7. **Add Pages custom domain** — `POST /accounts/{id}/pages/projects/{name}/domains`
8. **If email selected:**
   - Add domain to ForwardEmail account via API
   - Set MX records (mx1/mx2.forwardemail.net)
   - Set DKIM, SPF, DMARC, return-path DNS records
   - Create alias `{prefix}@{domain}` with `has_imap: true`
   - Generate password via `/aliases/{id}/generate-password`
9. **Poll site** — HEAD `https://{domain}` every 60s, max 30 attempts (30 min)
10. **Send Email 2** when domain returns HTTP 200

---

## Email 1 — "We're on it"

**From:** dean@alreadydone.uk  
**To:** customer personal email  
**Subject:** Your website is being built — ready in about 30 minutes

```
Hi [first name],

Payment confirmed — we're building your website now.

Here's what's happening:
  → Registering yourdomain.co.uk
  → Building your site
  [if email] → Setting up joe@yourdomain.co.uk

You'll get a second email from us within 30 minutes once
everything is live and tested. That email will have your
website link and [if email] full instructions for setting
up your email on your phone.

No action needed from you right now.

Dean
Already Done
```

---

## Email 2 — "You're live"

**From:** dean@alreadydone.uk  
**To:** customer personal email + {prefix}@{domain} (if email selected)  
**Subject:** Your website is live — everything you need inside

```
Hi [first name],

Everything is live. Here's what you've got:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR WEBSITE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
https://yourdomain.co.uk

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR EMAIL  [omit block if no email]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Address:  joe@yourdomain.co.uk
Password: [generated password]

Set it up on your phone (takes 2 minutes):

iPhone
Settings → Mail → Add Account → Other → Add Mail Account
  Name:     Joe Smith
  Email:    joe@yourdomain.co.uk
  Password: [password]
  Description: My Business Email
Then:
  Incoming: imap.forwardemail.net  Port 993  SSL
  Outgoing: smtp.forwardemail.net  Port 465  SSL

Android / Outlook
Add account → Other / IMAP → enter the same settings above.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RENEWAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Everything renews automatically one year from today.
You'll get an email before it happens. No surprises.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Any questions — reply to this email.

Dean
Already Done
alreadydone.uk
```

---

## Error handling

| Failure point | Action |
|---|---|
| Domain unavailable at checkout | Block checkout — offer alternatives |
| Porkbun registration fails | Slack alert to SLACK_DEV, Email 1 still sent, retry 3× |
| Cloudflare Pages deploy fails | Slack alert, retry 3× |
| Email provisioning fails | Slack alert, site goes live without email, Email 2 notes email "being set up separately" |
| Site never returns 200 after 30 min | Send Email 2 anyway with note: "may take a few more minutes to fully load" |

---

## API keys required

| Key | Where |
|---|---|
| `PORKBUN_API_KEY` / `PORKBUN_SECRET_KEY` | .env ✅ |
| `CLOUDFLARE_TOKEN` | .env ✅ (needs Zone:Create permission for new domains) |
| `CLOUDFLARE_ACCOUNT_ID` | hardcoded `c663467f92484cce5de42806e1a1e868` |
| `FORWARD_EMAIL_API_KEY` | .env ✅ |
| `RESEND_API_KEY` | .env ✅ |
| `STRIPE_WEBHOOK_SECRET` | .env ⬜ not yet |

---

## Known limitations / not yet built

- Stripe webhook handler (`/webhook/stripe`) — not built
- `provisionProspect()` orchestration function — not built
- Cloudflare token lacks Zone:Create — new domains can't be added as CF zones (workaround: Pages CNAME works if Porkbun DNS doesn't proxy through CF — currently working in practice)
- Domain availability must be checked at checkout time, not at build time
- Renewal billing — not automated (Stripe subscriptions not set up)
