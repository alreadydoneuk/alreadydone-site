#!/usr/bin/env node
// Director's all-hands meeting — 15 May 2026
// Runs each agent group with the director's specific brief injected into their context.
// Posts results to the appropriate Slack channels via the normal agent report hooks.
// One-time use — delete after running.

import 'dotenv/config';
import { agentCall } from '../lib/claude.js';
import { agentReport, eaBriefing } from '../lib/slack.js';
import { saveReport } from '../lib/reports.js';
import { supabase } from '../lib/db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Shared data ────────────────────────────────────────────────────────────────

const { data: pipelineSnap } = await supabase
  .from('businesses')
  .select('pipeline_status')
  .in('pipeline_status', ['researched', 'template_built', 'emailed', 'follow_up_sent', 'replied_positive', 'payment_pending', 'paid', 'delivered', 'dropped']);

const statusCounts = {};
for (const b of (pipelineSnap || [])) {
  statusCounts[b.pipeline_status] = (statusCounts[b.pipeline_status] || 0) + 1;
}
const pipelineSummary = Object.entries(statusCounts).map(([s, c]) => `- ${s}: ${c}`).join('\n');

// Pull a sample of actual sent email bodies so agents can assess the copy
const { data: sentEmails } = await supabase
  .from('interactions')
  .select('raw_content, metadata, created_at')
  .eq('type', 'email_sent')
  .order('created_at', { ascending: false })
  .limit(4);

const emailSamples = (sentEmails || []).map((e, i) =>
  `--- Email ${i + 1} (subject: "${e.metadata?.subject || 'unknown'}") ---\n${(e.raw_content || '').slice(0, 500)}`
).join('\n\n');

console.log('=== Director All-Hands Meeting — 15 May 2026 ===\n');

// ── Dev Team ───────────────────────────────────────────────────────────────────

console.log('[Dev] Running...');
const devReport = await agentCall(
  'meeting-dev',
  `You are the lead developer for Already Done, a one-person UK web design business.
You are responding to a direct message from the business owner about a serious operational issue.
Be honest, specific, and action-oriented. No waffle. Format for Slack with *bold* for key points.`,
  `Director's message: "Dev Team — we have had issues with the site builder. We have been sending out emails with no live preview site available. That is not acceptable. Assess where we are and how to make sure that never happens again."

Here is what happened and what has been fixed:

INCIDENT SUMMARY (15 May 2026):
- Site builder ran at 07:00, built 40 sites successfully, pushed to GitHub
- Deploy to Cloudflare Pages failed: /usr/bin/env: 'node': No such file or directory
- Root cause: deploy-site.sh did not export the nvm PATH — wrangler spawns child processes with #!/usr/bin/env node shebangs, which fail in cron's stripped PATH
- A previous fix (fcbb1fe) only set the full path to npx itself — wrangler subprocesses still failed
- Outreach ran at 10:00, 12:00, 14:00, 16:00 and sent 9 emails despite the deploy failure
- The preflight check passed because it sampled the 3 OLDEST businesses in the queue (sorted created_at asc) — those were from previous deployments and were live. Today's new builds (the risky ones) were never checked.

FIXES APPLIED TODAY:
1. deploy-site.sh: added export PATH="/home/brantley/.nvm/versions/node/v24.13.0/bin:$PATH" at top
2. deploy-site.sh: writes /home/brantley/alreadydone/.last_deploy_success timestamp on successful deploy
3. outreach-agent.js preflight: now sorts candidates by updated_at DESC (checks newest builds first, not oldest)
4. Preflight sample size increased from 3 to 5

CURRENT PIPELINE STATE:
${pipelineSummary}

Produce a dev team incident report for Slack:
1. *Incident summary* — what failed, what was the customer impact (any emails sent pointing to dead preview links?)
2. *Root causes* — two separate bugs (deploy script + preflight logic)
3. *Fixes applied* — what was changed and why it works
4. *Remaining risk* — is there anything else that could let this happen again?
5. *One recommended follow-up action* — what should be built next to prevent this class of failure permanently?

Keep under 400 words.`,
  1200,
);
await saveReport('meeting-dev', devReport);
await agentReport('dev', '🔧 Dev Team — Incident Report (Site Builder)', devReport);
console.log('[Dev] Done.\n');

await sleep(3000);

// ── Sales Team ─────────────────────────────────────────────────────────────────

console.log('[Sales Manager] Running...');
const salesManagerReport = await agentCall(
  'meeting-sales-manager',
  `You are the Sales Manager for Already Done, a one-person UK web design business selling £99 websites to SMEs.
You are responding to a direct challenge from the owner. Be brutally honest. No excuses, no spin.
Format for Slack with *bold* for key numbers and decisions.`,
  `Director's message: "All Sales — we have so far had no revenue. Look at the emails, the call to actions, the tone and communication we have done in our cold outreach and improve it. This is not OK and it's up to you to fix it. When do the follow up emails go out, are they going to get people to buy or do we need to make any changes to the plan?"

CURRENT PIPELINE:
${pipelineSummary}

First email sent: 10 May 2026 (5 days ago)
Follow-up delay configured: 5 days
Follow-ups actually sent: 0 (CRITICAL: run-follow-up.js has NO cron entry — it has never run)
Replies received: 0
Revenue: £0

SAMPLE OUTREACH EMAILS (assess tone, hook, CTA, length):
${emailSamples}

Produce a frank sales review for Slack:
1. *Pipeline reality* — where we actually are, what the numbers mean at 5 days in
2. *Email assessment* — honest critique of the copy samples above: does the hook work, is the length right, is the CTA clear enough, would YOU reply to this?
3. *Follow-up crisis* — the follow-up cron has never run. 5 days of no-reply businesses are sitting waiting. What needs to happen today.
4. *What needs to change* — specific, actionable recommendations on the email copy and sequence
5. *When will we see revenue* — realistic timeline given the pipeline state

Keep under 500 words. Be direct.`,
  1500,
);
await saveReport('meeting-sales-manager', salesManagerReport);
await agentReport('dev', '💼 Sales Manager — Revenue Review', salesManagerReport);
console.log('[Sales Manager] Done.\n');

await sleep(3000);

console.log('[Sales Director] Running...');
const salesDirectorReport = await agentCall(
  'meeting-sales-director',
  `You are the Sales Director for Already Done. You report directly to the owner.
This is a crisis meeting. The business has sent 77 emails and has zero revenue. Your job is to diagnose and direct.
Be decisive. No waffle. Format for Slack with *bold* for decisions.`,
  `Director's message: "All Sales — we have so far had no revenue. Look at the emails, the call to actions, the tone and communication, and improve it. This is not OK. When do follow up emails go out, are they going to get people to buy or do we need to make any changes to the plan?"

SALES FUNNEL STATE:
${pipelineSummary}

KEY FACTS:
- 77 emails sent, first batch went out 10 May (5 days ago)
- 0 replies, 0 conversions, £0 revenue
- Follow-up agent exists but has NO cron entry — has never run
- Email sequence: initial cold email → (5 day delay) follow-up → (14 day timeout) drop
- Price: £99 for a ready-built website
- Offer: we build it first, they see it, then decide — no obligation

KNOWN EMAIL ISSUES (from internal notes):
- Email opens with "My name's Dean" — hook (what you noticed about their business) should be first line
- 200 words with a 6-step structure — too long, too formulaic
- Recommended fix already identified: cut to 120–150 words, 3 beats (hook → preview → offer + risk reversal)

Produce a strategic sales directive for Slack:
1. *Diagnosis* — is zero reply at day 5 a crisis or normal? What's the realistic conversion timeline for cold email at £99?
2. *The follow-up gap* — this is the most immediate action. How many follow-ups should be going out today?
3. *Email strategy decision* — given the known issues, should we rewrite the emails now or let the current batch run its course and rewrite for the next cohort?
4. *One decision Dean needs to make today*
5. *Forecast* — with fixes in place, when should we see the first conversion?

Keep under 400 words. Be direct and decisive.`,
  1200,
);
await saveReport('meeting-sales-director', salesDirectorReport);
await agentReport('dev', '📊 Sales Director — Strategic Directive', salesDirectorReport);
console.log('[Sales Director] Done.\n');

await sleep(3000);

// ── EA ─────────────────────────────────────────────────────────────────────────

console.log('[EA] Running...');

const notionTasks = `OPEN TASKS FROM NOTION (Tasks & Next Actions — last updated 10 May 2026):

BLOCKERS:
- Domain expiry agent: imminent domains not added to pipeline (sets lead_temperature=hot but NOT pipeline_status=researched — may never reach outreach)
- Reply monitor: reply_count not selected, increment always produces 1
- preview_url column: verify it exists in businesses table

IMMEDIATE:
- Zoho aliases: add hello@, finance@, legal@, support@ to dean@alreadydone.uk (ops@ done)
- Check enrichment results from 792-business overnight run

LEGAL (BEFORE FIRST PAYMENT — URGENT):
- ICO registration: required under UK GDPR before processing customer data. ico.org.uk/fee. £52/year. DO BEFORE STRIPE.
- Stripe KYC: passport/driving licence + address + NI + UK bank account. Individual/Sole Trader.

PIPELINE QUALITY:
- Follow-up email rewrite: add domain suggestion hook, shorter + more human
- Email template rewrite: 120-150 words, lead with hook not name, separate follow-up prompt
- Suppression list: exclude DNC prospects from re-targeting

POST-PAYMENT:
- Customer info form → Claude rewrites copy from answers
- runCustomerServiceHandler() — live CS handler for paying customers
- Retention state machine (5% → 25% offer → auto-accept)
- DB migration: add cancellation_requested_at, retention_stage, service_ends_at, cancelled columns
- Stripe subscriptions for recurring billing

INFRASTRUCTURE:
- Cloudflare token Zone:Create permission (currently can only manage alreadydone.uk)
- Three-tier pricing on preview pages (£99/£179/£249)
- PostHog analytics on alreadydone.uk
- Tree planting partner (Ecologi / Trees for Life / Mossy Earth)
- Inbound /get-started page
- Slack Bot Token: EA needs channels:history scope to read #rougvie-ceo

TODAY'S PIPELINE STATE:
${pipelineSummary}

TODAY'S INCIDENTS:
- Site builder crashed (deploy PATH bug) — fixed and deployed
- Follow-up cron was never scheduled — emails should have been going out since today but weren't
- 9 outreach emails were sent this morning despite the deploy failure`;

const eaReport = await agentCall(
  'meeting-ea',
  `You are Dean Rougvie's Executive Assistant at Already Done.
Dean has asked you to review all outstanding notes and give him a clear, prioritised to-do list.
Do NOT mention tokens, compute costs, or API usage.
Be concise, practical, and human. Format for Slack with *bold* for priority items.`,
  `Dean's message: "EA — stop telling me about tokens. Look through all notes on Notion and tell me what I need to focus on. Tidy the notes up and give me my to-do list."

${notionTasks}

Produce a clean, prioritised to-do list for Dean. Group into:
1. *🚨 Do today* — things that are blocking the business or legally required right now
2. *📋 This week* — important but not blocking
3. *🔮 When pipeline starts converting* — build now to be ready

Be specific. For each item, one line max. No padding. If something is already done, skip it.
End with one sentence: what is the single most important thing Dean should do in the next hour.`,
  1500,
);
await saveReport('meeting-ea', eaReport);
await eaBriefing(`*🗓 Director's All-Hands — EA Briefing*\n\n${eaReport}`);
console.log('[EA] Done.\n');

console.log('=== Meeting complete. All reports posted to Slack. ===');
