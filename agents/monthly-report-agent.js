// Monthly business intelligence report agent.
// Runs on the 1st of each month at 9am.
//
// Two report paths:
//  'full'       — paid subscribers (order_include_report = true). Sent every month.
//  'free_trial' — all other delivered customers, once only, 30+ days after site went live.
//
// Each run: (1) capture fresh snapshot, (2) generate Claude narrative, (3) send email.

import { supabase, logInteraction } from '../lib/db.js';
import { captureSnapshot, getSnapshotPair } from '../lib/report-data.js';
import { generateReportEmail } from '../lib/report-template.js';
import { alert } from '../lib/slack.js';
import { Resend } from 'resend';
import Anthropic from '@anthropic-ai/sdk';
import { logTokens } from '../lib/tokens.js';
import 'dotenv/config';

const CHECKOUT_BASE = (process.env.CHECKOUT_BASE_URL || 'https://alreadydone.uk/checkout').replace('/checkout', '');
const HAIKU = 'claude-haiku-4-5-20251001';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function runMonthlyReportAgent() {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thirtyDaysAgo = new Date(now - THIRTY_DAYS_MS).toISOString();

  console.log(`\nMonthly report agent — period: ${period}`);

  // ── Fetch all delivered customers ──────────────────────────────────────────
  const { data: customers, error } = await supabase
    .from('businesses')
    .select(`
      id, name, category, location, customer_email, email,
      customer_first_name, registered_domain, place_id, google_rating,
      review_count, site_slug, delivered_at, last_report_sent_at,
      order_include_report, free_trial_report_sent_at, last_snapshot_at
    `)
    .eq('pipeline_status', 'delivered')
    .not('registered_domain', 'is', null);

  if (error) throw error;
  if (!customers?.length) {
    console.log('Monthly report: no delivered customers');
    return { sent: 0 };
  }

  console.log(`Found ${customers.length} delivered customer(s)`);

  let fullSent = 0;
  let trialSent = 0;

  for (const c of customers) {
    const to = c.customer_email || c.email;
    if (!to) { console.log(`  Skipping ${c.name} — no email`); continue; }

    const deliveredAt = c.delivered_at ? new Date(c.delivered_at) : null;
    const daysLive = deliveredAt ? Math.floor((now - deliveredAt) / 86400000) : 0;

    const isPaidSubscriber = c.order_include_report === true;
    const alreadySentThisPeriod = c.last_report_sent_at
      && new Date(c.last_report_sent_at) > new Date(now.getFullYear(), now.getMonth(), 1);
    const eligibleForTrial = !isPaidSubscriber
      && !c.free_trial_report_sent_at
      && daysLive >= 30;

    if (!isPaidSubscriber && !eligibleForTrial) continue;
    if (alreadySentThisPeriod && isPaidSubscriber) {
      console.log(`  Skipping ${c.name} — already sent this period`);
      continue;
    }

    console.log(`\n  ${c.name} [${isPaidSubscriber ? 'paid' : 'free trial'}, ${daysLive} days live]`);

    try {
      // ── 1. Capture snapshot ──────────────────────────────────────────────
      const snapshot = await captureSnapshot(c, period);
      const { previous } = await getSnapshotPair(c.id);

      // ── 2. Generate narrative ────────────────────────────────────────────
      const narrative = await generateNarrative(c, snapshot, previous, isPaidSubscriber);

      // ── 3. Get or create tracking_id in report_history ───────────────────
      const trackingId = await upsertReportHistory({
        businessId: c.id,
        period,
        reportType: isPaidSubscriber ? 'full' : 'free_trial',
        emailTo: to,
        subject: `Your ${formatPeriod(period)} report — ${c.registered_domain}`,
      });

      // ── 4. Generate HTML ─────────────────────────────────────────────────
      const upgradeUrl = `${CHECKOUT_BASE}/checkout?slug=${c.site_slug}&report=1`;
      const html = generateReportEmail({
        business: c,
        current: snapshot,
        previous,
        narrative,
        reportType: isPaidSubscriber ? 'full' : 'free_trial',
        trackingId,
        upgradeUrl,
        period,
      });

      // ── 5. Send ──────────────────────────────────────────────────────────
      const subject = `Your ${formatPeriod(period)} business report — ${c.registered_domain}`;
      await sendReport({ to, subject, html });

      // ── 6. Update DB ─────────────────────────────────────────────────────
      const updates = { last_report_sent_at: now.toISOString() };
      if (!isPaidSubscriber) updates.free_trial_report_sent_at = now.toISOString();
      await supabase.from('businesses').update(updates).eq('id', c.id);

      await logInteraction(c.id, 'monthly_report', 'outbound',
        `${isPaidSubscriber ? 'Full' : 'Free trial'} report sent to ${to} (${period})`,
        null,
        { period, reportType: isPaidSubscriber ? 'full' : 'free_trial', trackingId }
      );

      isPaidSubscriber ? fullSent++ : trialSent++;
      console.log(`  ✓ ${c.name} — ${subject}`);

    } catch (err) {
      console.error(`  ✗ Failed for ${c.name}: ${err.message}`);
      await alert(`⚠️ Monthly report failed — ${c.name}\n${err.message}`).catch(() => {});
    }

    await sleep(2000);
  }

  const summary = [
    fullSent > 0 ? `${fullSent} full report${fullSent !== 1 ? 's' : ''}` : null,
    trialSent > 0 ? `${trialSent} free trial${trialSent !== 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(', ');

  if (summary) {
    await alert(`📊 Monthly reports sent — ${summary}`).catch(() => {});
    console.log(`\nDone — ${summary}`);
  } else {
    console.log('\nNothing sent this run');
  }

  return { fullSent, trialSent };
}

// ── Claude narrative ──────────────────────────────────────────────────────────

async function generateNarrative(business, current, previous, isPaid) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const rankLine = current.search_rank
    ? `Local search rank: #${current.search_rank} for "${current.search_keyword}"`
    : `Not found in top 10 for "${current.search_keyword}"`;

  const reviewLine = current.review_count != null
    ? `${current.review_count} reviews, ${current.google_rating ?? '?'}★`
    : 'review data unavailable';

  const prevRankLine = previous?.search_rank ? `Previous rank: #${previous.search_rank}` : '';
  const prevReviewLine = previous?.review_count ? `Previous reviews: ${previous.review_count}` : '';

  const competitorSummary = (current.competitors || []).slice(0, 3)
    .map(c => `${c.title}: ${c.review_count || '?'} reviews, ${c.rating || '?'}★`)
    .join('; ') || 'No competitor data';

  const newCo = current.new_competitors_30d > 0
    ? `${current.new_competitors_30d} new businesses registered nearby`
    : 'No new competitors this month';

  const prompt = `Write a brief, professional analyst comment (3–4 short paragraphs, max 120 words total) for a local business owner's monthly report.

Business: ${business.name} (${business.category}, ${business.location})
This month: ${rankLine}. ${reviewLine}.
${prevRankLine} ${prevReviewLine}
Top competitors: ${competitorSummary}
New competition: ${newCo}
${!isPaid ? 'Note: this is a free trial report.' : ''}

Tone: warm, direct, like a knowledgeable local business adviser. Point out one thing going well and one clear action. No bullet points. No corporate language. No em dashes.`;

  const message = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 250,
    messages: [{ role: 'user', content: prompt }],
  });

  await logTokens('monthly-report-narrative', HAIKU, message.usage.input_tokens, message.usage.output_tokens);
  return message.content[0].text.trim();
}

// ── Report history upsert ─────────────────────────────────────────────────────

async function upsertReportHistory({ businessId, period, reportType, emailTo, subject }) {
  // Check if already exists (for idempotency — in case agent runs twice)
  const { data: existing } = await supabase
    .from('report_history')
    .select('tracking_id')
    .eq('business_id', businessId)
    .eq('period', period)
    .single();

  if (existing?.tracking_id) return existing.tracking_id;

  const { data } = await supabase
    .from('report_history')
    .insert({
      business_id: businessId,
      period,
      report_type: reportType,
      email_sent_to: emailTo,
      subject,
    })
    .select('tracking_id')
    .single();

  return data?.tracking_id;
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function sendReport({ to, subject, html }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const testEmail = process.env.TEST_EMAIL;
  const actualTo = testEmail || to;
  if (testEmail) console.log(`    ⚠️  TEST MODE → ${testEmail}`);

  const { error } = await resend.emails.send({
    from: `${process.env.FROM_NAME || 'Dean'} <${process.env.FROM_EMAIL || 'dean@alreadydone.uk'}>`,
    to: actualTo,
    subject,
    html,
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPeriod(period) {
  if (!period || period === 'baseline') return 'Baseline';
  const [year, month] = period.split('-');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(month, 10) - 1]} ${year}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
