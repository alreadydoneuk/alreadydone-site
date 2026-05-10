import { generateNoReplyFollowUp, generateStatusFollowUp } from '../lib/claude.js';
import { sendOutreachEmail, sendAutoReply } from '../lib/mailer.js';
import { supabase } from '../lib/db.js';
import 'dotenv/config';

// Handles two distinct follow-up paths:
// 1. No-reply path — businesses that were emailed but never replied (pipeline_status = 'emailed')
// 2. Post-reply path — businesses that replied and engaged but then went quiet (follow_up_due_at overdue)

const FOLLOW_UP_DELAY_DAYS = parseInt(process.env.FOLLOW_UP_DELAY_DAYS || '5');
const NO_REPLY_TIMEOUT_DAYS = parseInt(process.env.NO_REPLY_TIMEOUT_DAYS || '14');
const BASE_PRICE = parseInt(process.env.BASE_PRICE_GBP || '99');
const CHECKOUT_BASE_URL = process.env.CHECKOUT_BASE_URL || 'https://alreadydone.uk/checkout';
const BATCH_SIZE = 10;

export async function runFollowUpAgent() {
  const now = new Date();
  const followUpCutoff = new Date(now - FOLLOW_UP_DELAY_DAYS * 86400000).toISOString();
  const dropCutoff = new Date(now - NO_REPLY_TIMEOUT_DAYS * 86400000).toISOString();

  // ── Path 1a: Drop timed-out no-reply businesses ──────────────────────────
  const { data: tooDrop } = await supabase
    .from('businesses')
    .select('id, name, first_email_sent_at')
    .eq('pipeline_status', 'emailed')
    .lt('first_email_sent_at', dropCutoff)
    .limit(100);

  let dropped = 0;
  for (const b of tooDrop || []) {
    await supabase.from('businesses').update({
      pipeline_status: 'dropped',
      dropped_at_stage: 'follow_up',
      drop_reason: 'no_reply_timeout',
    }).eq('id', b.id);
    await supabase.from('interactions').insert({
      business_id: b.id,
      type: 'dropped',
      direction: 'internal',
      content_summary: `No reply after ${NO_REPLY_TIMEOUT_DAYS} days — dropped`,
    });
    dropped++;
  }
  if (dropped > 0) console.log(`Dropped ${dropped} timed-out businesses`);

  // ── Path 1a2: Drop timed-out follow_up_sent businesses ───────────────────
  // Businesses that got a follow-up but still never replied — give up after NO_REPLY_TIMEOUT_DAYS
  const { data: followUpDropCandidates } = await supabase
    .from('businesses')
    .select('id, name, follow_up_sent_at')
    .eq('pipeline_status', 'follow_up_sent')
    .lt('follow_up_sent_at', dropCutoff)
    .limit(100);

  for (const b of followUpDropCandidates || []) {
    await supabase.from('businesses').update({
      pipeline_status: 'dropped',
      dropped_at_stage: 'follow_up',
      drop_reason: 'no_reply_after_followup',
    }).eq('id', b.id);
    await supabase.from('interactions').insert({
      business_id: b.id,
      type: 'dropped',
      direction: 'internal',
      content_summary: `No reply after follow-up (${NO_REPLY_TIMEOUT_DAYS} days) — dropped`,
    });
    dropped++;
  }
  if (followUpDropCandidates?.length) console.log(`Dropped ${followUpDropCandidates.length} timed-out follow_up_sent businesses`);

  // ── Path 1b: Drop post-reply businesses that have gone cold past 14 days ─
  // These engaged but follow_up_due_at has passed a second time — give up
  const engagedDropCutoff = new Date(now - (NO_REPLY_TIMEOUT_DAYS + 5) * 86400000).toISOString();
  const { data: engagedDropCandidates } = await supabase
    .from('businesses')
    .select('id, name, last_reply_at')
    .in('pipeline_status', ['engaged', 'nurturing'])
    .lt('last_reply_at', engagedDropCutoff)
    .is('follow_up_due_at', null)
    .limit(50);

  for (const b of engagedDropCandidates || []) {
    await supabase.from('businesses').update({
      pipeline_status: 'dropped',
      dropped_at_stage: 'post_reply_nurture',
      drop_reason: 'no_response_after_followup',
    }).eq('id', b.id);
    await supabase.from('interactions').insert({
      business_id: b.id,
      type: 'dropped',
      direction: 'internal',
      content_summary: `No response after post-reply follow-up — dropped`,
    });
    dropped++;
  }

  // ── Path 2: Post-reply follow-ups (follow_up_due_at overdue) ─────────────
  const { data: postReplyLeads } = await supabase
    .from('businesses')
    .select('*')
    .in('pipeline_status', ['payment_pending', 'engaged', 'nurturing'])
    .lte('follow_up_due_at', now.toISOString())
    .neq('do_not_contact', true)
    .order('follow_up_due_at', { ascending: true })
    .limit(BATCH_SIZE);

  let postReplySent = 0;

  for (const business of postReplyLeads || []) {
    try {
      await sendPostReplyFollowUp(business);
      postReplySent++;
    } catch (err) {
      console.error(`  Post-reply follow-up failed: ${business.name} — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (postReplySent > 0) console.log(`Post-reply follow-ups sent: ${postReplySent}`);

  // ── Path 1c: Initial no-reply follow-ups ─────────────────────────────────
  // Generic email businesses first (direct to owner → higher reply rate), then business domain
  const { data: genericLeads } = await supabase
    .from('businesses')
    .select('*')
    .eq('pipeline_status', 'emailed')
    .eq('email_type', 'generic')
    .is('follow_up_sent_at', null)
    .lt('first_email_sent_at', followUpCutoff)
    .order('first_email_sent_at', { ascending: true })
    .limit(BATCH_SIZE);

  const remaining = BATCH_SIZE - (genericLeads?.length || 0);
  const { data: otherLeads } = remaining > 0 ? await supabase
    .from('businesses')
    .select('*')
    .eq('pipeline_status', 'emailed')
    .neq('email_type', 'generic')
    .is('follow_up_sent_at', null)
    .lt('first_email_sent_at', followUpCutoff)
    .order('first_email_sent_at', { ascending: true })
    .limit(remaining) : { data: [] };

  const toFollow = [...(genericLeads || []), ...(otherLeads || [])];

  if (!toFollow.length && !postReplySent) {
    console.log('Follow-up: nothing ready yet');
    return { sent: 0, postReplySent, dropped };
  }

  if (toFollow.length) console.log(`Follow-up: ${toFollow.length} no-reply businesses ready`);
  let sent = 0;

  for (const business of toFollow) {
    try {
      const previewUrl = business.preview_url || null;

      const body = await generateFollowUp({
        name: business.name,
        category: business.category,
        location: business.location,
        domain: business.domain,
        website_status: business.website_status,
        price: BASE_PRICE,
        previewUrl,
      });

      const subject = `Re: ${business.name} — just checking in`;

      const { messageId: followUpMsgId } = await sendOutreachEmail({
        to: business.email,
        subject,
        body,
        previewUrl,
        screenshotPath: business.template_screenshot,
      });

      await supabase.from('businesses').update({
        pipeline_status: 'follow_up_sent',
        follow_up_sent_at: new Date().toISOString(),
        outreach_message_id: followUpMsgId || null,
      }).eq('id', business.id);

      await supabase.from('interactions').insert({
        business_id: business.id,
        type: 'follow_up_sent',
        direction: 'outbound',
        content_summary: `Follow-up sent to ${business.email}`,
        raw_content: body,
        metadata: { messageId: followUpMsgId },
      });

      console.log(`  ✓ Follow-up sent: ${business.name}`);
      sent++;
    } catch (err) {
      console.error(`  Failed: ${business.name} — ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  return { sent, postReplySent, dropped };
}

async function sendPostReplyFollowUp(business) {
  const status = business.pipeline_status;
  const checkoutUrl = business.site_slug
    ? `${CHECKOUT_BASE_URL}?slug=${business.site_slug}`
    : CHECKOUT_BASE_URL;

  const body = await generateStatusFollowUp(business, status, checkoutUrl);
  if (!body) {
    console.log(`  Skipping post-reply follow-up for ${business.name} — no template for status ${status}`);
    return;
  }

  const subject = `Re: ${business.name} — just checking in`;

  // Thread onto the most recent outbound message so it arrives in the same conversation
  await sendAutoReply({
    to: business.email,
    subject,
    body,
    inReplyTo: business.outreach_message_id || null,
  });

  // Clear follow_up_due_at so we don't re-send; keep status as-is
  await supabase.from('businesses').update({
    follow_up_due_at: null,
  }).eq('id', business.id);

  await supabase.from('interactions').insert({
    business_id: business.id,
    type: 'follow_up_sent',
    direction: 'outbound',
    content_summary: `Post-reply follow-up sent to ${business.email} [${status}]`,
    raw_content: body,
    metadata: { status, checkoutUrl: status === 'payment_pending' ? checkoutUrl : null },
  });

  console.log(`  ✓ Post-reply follow-up sent [${status}]: ${business.name}`);
}

async function generateFollowUp(b) {
  return generateNoReplyFollowUp({
    name: b.name,
    category: b.category,
    location: b.location,
    domain: b.domain,
    website_status: b.website_status,
    price: b.price,
    previewUrl: b.previewUrl || null,
  });
}
