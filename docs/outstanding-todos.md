# Already Done — Outstanding To-Dos
Last updated: 2026-05-08

---

## BLOCKERS — nothing ships without these

### 1. Stripe webhook + provisionProspect()
The entire checkout automation. No code exists yet.
- Build `/webhook/stripe` endpoint (Cloudflare Worker or small Node server)
- Add `STRIPE_WEBHOOK_SECRET` to .env
- Build `provisionProspect({ domain, emailPrefix, businessName, customerEmail, plan })` in `lib/provision.js`
- Wire up: domain register → DNS → site build → CF Pages deploy → email setup → poll → send emails
- Full spec: `docs/prospect-onboarding-flow.md`

### 2. Google CSE API key
`GOOGLE_PLACES_API_KEY` is a Maps Platform key, blocked for Custom Search API.
- Go to Google Cloud Console → Credentials → Create API Key
- Enable "Custom Search API" on the new key
- Replace `GOOGLE_PLACES_API_KEY` usages in `lib/directory-finder.js` with new key
- Add as `GOOGLE_CSE_API_KEY` to .env
- Until this is fixed: enrichment agent finds 0 emails for no-website businesses

---

## HIGH — should be done before first paid sale

### 3. Cloudflare token permissions
Current token (`CLOUDFLARE_TOKEN`) can only manage `alreadydone.uk` zone and deploy to Pages.
- Needs Zone:Create to add prospect domains as CF zones (required at scale)
- Workaround currently works (CNAME to pages.dev without CF zone) but fragile
- Create new token in CF dashboard with: Zone:Edit (all zones) + Zone:Create + Pages:Edit

### 4. Domain availability check at checkout
Must verify domain is available before taking payment.
- Porkbun `/domain/checkDomain/{domain}` returns avail + price
- Block checkout if unavailable, suggest alternatives (checkDomain for .com and .uk variants)
- Pass exact price (in pennies) through to registration step

### 5. Annual renewal / Stripe subscriptions
No automated rebilling exists.
- Set up Stripe subscription for each customer (domain + site + email)
- On renewal failure: warn customer, give 14-day grace period, suspend site + email
- Domain renewal at Porkbun happens automatically if account has credit — ensure balance maintained

### 6. Prospect email onboarding emails
The two emails are designed (`docs/prospect-onboarding-flow.md`) but not coded.
- `lib/mailer.js` needs `sendOnboardingStarted()` and `sendOnboardingComplete()` functions
- Email 2 must include conditional email block (only if plan includes email)
- Email 2 must only send after site HTTP check passes

---

## MEDIUM — pipeline quality / scale

### 7. Reply handling upgrade (reply-monitor-agent.js)
Full spec: docs/reply-and-cs-decision-tree.md — Flow A
Full classification spec: Notion → Email Agent — Prospect Decision Tree & SOP (2A–2K)
- Distinguish prospect vs customer at top of flow (check businesses.pipeline_status)
- Implement full 2A–2K sub-classification (currently only positive/negative/neutral)
- Auto-reply via Resend for all except 2H (hostile — always manual)
- Domain parsing: personal email → register domain; business email → use existing
- do_not_contact / SUPPRESSED flag, bounce handling, out-of-office re-queue
- 48h payment nudge for 2A (ready to buy but hasn't paid)
- Rate limit: max 1 auto-reply per business per 24h

### 8. Customer service live handler (customer-service-agent.js)
Full spec: docs/reply-and-cs-decision-tree.md — Flow B + Retention
Note: existing CS agent is a weekly quality reporter — this is a separate live handler
- Build runCustomerServiceHandler() — triggered by reply-monitor when sender is a customer
- Site health check (HEAD to their domain), ForwardEmail alias check + credential reset
- Auto-reply templates for all issue types
- Retention state machine (5% → 25% → auto-accept, services end at term date)
- Scheduled nightly job: disable services on service_ends_at date
- DB migration: do_not_contact, reply_intent, cancellation fields, retention_stage, service_ends_at

### 9. Auto-reply templates (prompts/reply-templates.js)
Full list in docs/reply-and-cs-decision-tree.md — copy to be written for all 19 templates
Prospect (10): positiveReply, pricingQuery, packageQuery, previewRequest, processQuery,
  confusedExplain, domainQuestion, customisationAck, alreadyHasSite, unsubscribeConfirm
CS (9): siteDownAcknowledge, siteDownLocalIssue, emailSetupHelp, billingInfo,
  contentChangeAck, retention5pct, retention25pct, cancellationConfirmed, serviceEndedFinal

### 10. Outreach email template rewrite
Current template works but needs refresh — tone, structure, subject line testing.

### 8. Follow-up email rewrite
Same issue. Second email is weaker than the first.

### 9. Suppression list
No global suppression. Need to ensure:
- Unsubscribe link in all outreach emails
- Bounces and complaints auto-suppress in Resend
- `businesses` table flag: `do_not_contact`

### 10. Per-prospect Cloudflare Pages project
Currently site builder puts preview at `alreadydone.uk/preview/{slug}`.
After payment it needs its own Pages project + custom domain.
- `lib/domains.js` has `pointToCloudflarePages()` — wiring needed in provision flow
- Build step: `wrangler pages deploy` per prospect

---

## LOW — nice to have / future

### 11. OCIW GitHub push
`/tmp/OfCourseItWentWrong` has 2 unpushed commits (chapters page rewrite + CNAME/config).
- Blocked by missing SSH key for github.com on this machine
- Add `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF3S7wdUqkCOOHo87VeTou08a78ocMb0iQKp/STHoSXP operator` to GitHub → Settings → SSH Keys
- Then: `git -C /tmp/OfCourseItWentWrong push origin main`

### 12. Slack bot token (EA)
EA can write to Slack but not read #rougvie-ceo messages.
- Needs proper bot token with `channels:history` scope

### 13. Webmail (future upgrade path)
ForwardEmail has no webmail. If customers request browser access:
- Upgrade path: Zoho Mail Lite at £1/user/month
- Could be an upsell: "access your email from any browser — £1/month"

---

## DONE (this session, 2026-05-07/08)

- ✅ Porkbun API domain registration — fixed (domain in URL path, cost in pennies, agreeToTerms required)
- ✅ `lib/domains.js` — fully rewritten with correct API, checkDomain, registerDomain, pointToGitHubPages, pointToCloudflarePages
- ✅ ForwardEmail account created (ops@alreadydone.uk, Enhanced plan, $3/month)
- ✅ FORWARD_EMAIL_API_KEY added to .env
- ✅ ForwardEmail IMAP mailbox tested end-to-end (dave@ofcourseitwentwrong.co.uk)
- ✅ ofcourseitwentwrong.co.uk registered, site deployed, email set up, DNS complete
- ✅ Onboarding flow documented (docs/prospect-onboarding-flow.md)
- ✅ OCIW site deployed to Cloudflare Pages + custom domain live
- ✅ Notion export of all 70 OCIW chapters
- ✅ OCIW chapters page rewritten (all listed, only published linked, right series greyed out)
