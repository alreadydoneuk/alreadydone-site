# Reply Handling & Customer Service — Decision Trees
Last updated: 2026-05-08

**Source of truth for prospect reply classification: Notion → Email Agent — Prospect Decision Tree & SOP**
This doc extends that with: implementation notes, the CS live handler spec, and the retention/cancellation flow.

---

## Two separate flows

**Flow A — Prospect replies** (inbound to dean@alreadydone.uk, sender is a prospect)
**Flow B — Customer issues** (inbound from paying customers — status paid/delivered)

Determined at the top of reply-monitor-agent by matching sender domain against `businesses` table status.
Unknown sender → Slack SLACK_LEADS, no action.

---

## How to tell them apart

| Signal | Prospect | Customer |
|---|---|---|
| DB status | emailed, follow_up_sent, engaged, nurturing, payment_pending | paid, delivered |
| Sender domain | their business domain or personal email | their business domain or new @theirdomain address |

---

## FLOW A — Prospect replies (2A–2K, per Notion spec)

Full response copy lives in Notion: **Email Agent — Prospect Decision Tree & SOP**.
Summary of classifications and DB actions:

| Code | Classification | DB Status | Auto-reply | Follow-up |
|---|---|---|---|---|
| 2A | Ready to buy | PAYMENT_PENDING | Yes — payment link | 48h nudge if no payment |
| 2B | Interested, has questions | ENGAGED | Yes — answer + soft CTA | 5 days if quiet |
| 2C | Wants changes before buying | ENGAGED | Yes — make change, resend preview | 5 days if quiet |
| 2D | Already has website | CLOSED_HAS_SITE | Yes — apologise, exit | None |
| 2E | Curious, noncommittal | NURTURING | Yes — no pressure, seed value | Day 5 nudge, day 12 expiry reminder |
| 2F | Price negotiation | ENGAGED or COLD | Yes — hold £99, reframe value | None if they go cold |
| 2G | Unsubscribe / not interested | SUPPRESSED | Yes — brief apology, confirm removal | None |
| 2H | Hostile / threatening | ESCALATED | No — manual review flag to Slack | None |
| 2I | Confused / doesn't understand | ENGAGED | Yes — explain plainly, soft CTA | 5 days |
| 2J | Domain / hosting questions | ENGAGED | Yes — answer routing question | 5 days |
| 2K | Post-payment (Stripe webhook) | PAID | Yes — confirmation + next steps | — |

### Key rules (from Notion)
- **Never discount the £99 tier** (2F) — reframe value instead
- **Never auto-reply to 2H** — always flag to Slack for Dean's manual response
- **One CTA per email max**
- **Always sign as Dean**, not as a company
- **Tone**: warm, peer-to-peer, never pushy

### Domain routing at reply stage (per Notion domain parsing spec)
When a reply arrives, check the sender's email domain:
- **Personal domain** (gmail, yahoo, hotmail, outlook, icloud, etc.) → prospect doesn't own a domain → Flow 1: Already Done registers domain, charge cost + 20%
- **Business domain** (anything else) → prospect likely owns it → Flow 2: WHOIS lookup, registrar-specific DNS instructions, no registration charge
- Pre-select at checkout, allow override toggle ("I don't own a domain" / "I already have a domain")

### Follow-up timing (per Notion Stage 3)
| Scenario | Timing | Max follow-ups | If no response |
|---|---|---|---|
| No reply to outreach | Day 5 | 1 | Mark COLD, delete preview |
| Engaged, gone quiet | Day 5 after last reply | 1 | Mark COLD |
| Payment pending, not paid | 48h after link sent | 1 | Mark COLD |
| Preview expiry reminder | Day 12 | 1 | Delete preview day 14 |

---

## FLOW B — Customer issues (live CS handler)

**Note:** The existing customer-service-agent.js is a weekly quality reporting agent — this is a separate live handler that fires when a paying customer emails in.

### Issue classification

```
Inbound from paying customer
│
├─► TECHNICAL — site down / not loading
│     → HEAD request to https://{domain}
│     ├─ Returns 200 → local/cache issue on their end
│     │   Auto-reply: "Loading fine from our end — try another browser or phone data.
│     │   If still broken, reply and I'll look at it."
│     └─ Returns error/timeout
│         → Slack SLACK_DEV immediately 🚨
│         Auto-reply: "I can see the issue — on it now, back up within the hour."
│         Dean fixes → sends confirmation
│
├─► TECHNICAL — email not working / can't set up
│     → Auto-reply with full IMAP/SMTP credentials + iPhone/Outlook steps
│     → If they reply again still stuck:
│         Check ForwardEmail alias via API (is_enabled)
│         Regenerate password, send new credentials
│         Slack SLACK_DEV if still unresolved
│
├─► BILLING — renewal date, amount, change card
│     Auto-reply: renewal date, amount breakdown, Stripe customer portal link
│     Slack SLACK_LEADS: info note
│
├─► CONTENT CHANGE — update text, phone, address, services
│     Auto-reply: "On it — updated within 24 hours."
│     Slack SLACK_CEO: 📝 content change request + details
│     Dean updates manually → sends confirmation
│     [Future: simple field changes (phone/address) auto-update and redeploy]
│
├─► CANCELLATION → see Retention Flow below
│
├─► COMPLAINT — angry, formal, threatening
│     Do NOT auto-reply
│     Slack SLACK_CEO 🔴 immediately
│     Dean responds personally within 1 hour
│
└─► GENERAL QUESTION
      Claude attempts answer from known package details
      If confident: auto-reply + Slack note
      If not confident: Slack SLACK_CEO, no auto-reply
```

---

## RETENTION FLOW — Cancellation request

The customer keeps full access until the end of their paid term regardless of outcome.
Never cut off services immediately on cancellation request.

```
Customer requests cancellation
│
├─ Log: cancellation_requested_at = now()
├─ Do NOT cancel anything yet
│
└─► ATTEMPT 1 — 5% discount offer
      Auto-reply:
        "Sorry to hear that — before you go, we'd like to offer you 5% off your
         next year. That brings your renewal down to [£X]. Just reply YES to lock
         that in. No action needed from you other than that."
      DB: retention_stage = 1, retention_offered_at = now()
      Slack SLACK_CEO: ⚠️ cancellation request, 5% offer sent
      │
      ├─ They accept (reply YES / positive):
      │   Apply 5% to next Stripe invoice
      │   Auto-reply: "Done — renewal locked in at [£X]. You'll hear from us
      │   before it renews. Thanks for staying."
      │   DB: retention_stage = 0, cancelled = false
      │
      ├─ They decline (reply NO / not interested):
      │   → Jump straight to Attempt 2
      │
      └─ No reply within 7 days:
          → Attempt 2
│
└─► ATTEMPT 2 — 25% discount offer
      Auto-reply:
        "Completely understand. Last thing from us — we can offer 25% off your
         renewal, bringing it to [£X]. If that works, reply YES. If not,
         no hard feelings — we'll keep everything running until [term end date]
         and close things down cleanly then."
      DB: retention_stage = 2, retention_stage2_at = now()
      Slack SLACK_CEO: ⚠️ 25% retention offer sent to [Name]
      │
      ├─ They accept:
      │   Apply 25% to next Stripe invoice
      │   Auto-reply: "Brilliant — renewal at [£X] confirmed. Thanks for giving
      │   us another chance."
      │   DB: retention_stage = 0, cancelled = false
      │
      ├─ They decline:
      │   → Auto-accept cancellation
      │
      └─ No reply within 7 days:
          → Auto-accept cancellation
│
└─► AUTO-ACCEPT CANCELLATION
      DB: cancelled = true, service_ends_at = [current term end date]
      Stripe: cancel subscription at period end (NOT immediately)
      Auto-reply:
        "Understood — we've cancelled your renewal. Everything stays live until
         [term end date]. After that, your site and email will be closed down.
         If you change your mind before then, just reply and we'll reinstate.
         Thanks for being a customer."
      Slack SLACK_CEO: cancellation confirmed for [Name], ends [date]
      │
      └─► ON TERM END DATE (scheduled job):
            Disable ForwardEmail alias (API: is_enabled = false)
            Point domain to parked/expired page (do not delete — domain stays registered
            until next renewal date in case they want to reinstate or transfer)
            Send final email:
              "Your website and email have now closed. Your domain [domain] remains
               registered until [domain expiry date]. If you'd like to transfer it
               to another provider, reply and we'll send transfer instructions.
               Thanks again — good luck with the business."
            DB: status = churned
```

### Retention DB fields needed
- `businesses.cancellation_requested_at` (timestamp)
- `businesses.retention_stage` (int: 0=none, 1=5% offered, 2=25% offered)
- `businesses.retention_offered_at` (timestamp)
- `businesses.cancelled` (boolean)
- `businesses.service_ends_at` (date — their paid term end)

---

## What needs building

### reply-monitor-agent.js additions
- [ ] Distinguish prospect vs customer at top of flow (check DB status)
- [ ] Full 2A–2K sub-classification (currently only positive/negative/neutral)
- [ ] Auto-reply via Resend for all non-2H classifications
- [ ] Domain parsing logic (personal vs business email → domain flow routing)
- [ ] do_not_contact / SUPPRESSED flag handling
- [ ] Out-of-office detection + re-queue
- [ ] Bounce detection
- [ ] 48h payment nudge for 2A
- [ ] Rate limit: max 1 auto-reply per business per 24h

### New: runCustomerServiceHandler() in customer-service-agent.js
- [ ] Site health check
- [ ] ForwardEmail alias check + password reset
- [ ] Auto-reply templates (billing, email help, content change ack, site down ack)
- [ ] Retention flow state machine
- [ ] Scheduled job: service termination on term end date

### Retention-specific
- [ ] DB migration: add retention fields + service_ends_at + cancelled
- [ ] Stripe: cancel at period end (not immediately) via API
- [ ] Scheduled nightly job: check service_ends_at, disable services on the day

### Auto-reply templates (prompts/reply-templates.js)
All named exports, copy finalised in Notion (prospect) and here (CS):
- Prospect: positiveReply, pricingQuery, packageQuery, previewRequest, processQuery, confusedExplain, domainQuestion, customisationAck, alreadyHasSite, unsubscribeConfirm
- CS: siteDownAcknowledge, siteDownLocalIssue, emailSetupHelp, billingInfo, contentChangeAck, retention5pct, retention25pct, cancellationConfirmed, serviceEndedFinal
