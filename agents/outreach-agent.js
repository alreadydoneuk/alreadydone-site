import { getBusinessesByStatus, updateBusiness, logInteraction } from '../lib/db.js';
import { generateEmail } from '../lib/claude.js';
import { findEmail, isGenericEmailDomain } from '../lib/email-finder.js';
import { sendOutreachEmail } from '../lib/mailer.js';
import { isEmailable } from '../lib/parked.js';
import 'dotenv/config';

const BATCH_SIZE = 10;
const BASE_PRICE = parseInt(process.env.BASE_PRICE_GBP || '99');

function isWithinBusinessHours() {
  const now = new Date();
  const ukTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: 'numeric', hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const ukHour = parseInt(ukTime.find(p => p.type === 'hour').value, 10);
  const ukDay  = ukTime.find(p => p.type === 'weekday').value; // Mon Tue Wed Thu Fri Sat Sun
  const isWorkingHour = ukHour >= 9 && ukHour < 18;
  return isWorkingHour;
}

export async function runOutreachAgent({ force = false } = {}) {
  if (!force && !isWithinBusinessHours()) {
    console.log('Outreach skipped — outside UK business hours (09:00–18:00)');
    return { sent: 0, skipped: true };
  }
  const businesses = await getBusinessesByStatus('template_built');

  if (businesses.length === 0) {
    console.log('No template_built businesses to email');
    return { sent: 0 };
  }

  const batch = businesses.slice(0, BATCH_SIZE);
  console.log(`\nSending outreach for ${batch.length} businesses`);

  let sent = 0;

  for (const business of batch) {
    try {
      const result = await sendOutreachForBusiness(business);
      if (result) sent++;
    } catch (err) {
      console.error(`  Failed for ${business.name}: ${err.message}`);
      await logInteraction(business.id, 'error', 'internal', `Outreach failed: ${err.message}`, err.stack);
    }

    // Rate limit: don't hammer the mail server
    await sleep(2000);
  }

  console.log(`\nSent ${sent}/${batch.length} emails\n`);
  return { sent };
}

async function sendOutreachForBusiness(business) {
  console.log(`\n  Outreach: ${business.name} [${business.website_status}]`);

  // broken_dns: MX records are also gone so custom domain email would bounce
  if (!isEmailable(business.website_status)) {
    console.log(`    Skipping — ${business.website_status} not emailable`);
    await updateBusiness(business.id, {
      pipeline_status: 'dropped',
      dropped_at_stage: 'outreach',
      drop_reason: `not_emailable_${business.website_status}`,
    });
    return false;
  }

  // Expiry timing gate:
  // - Expired domain + generic email (Gmail etc): send the day after expiry — they still have email
  // - Expiring soon + custom domain email: send the day before — after expiry their email dies too
  if (business.whois_expiry_date) {
    const expiry = new Date(business.whois_expiry_date);
    expiry.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daysUntilExpiry = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
    const emailIsGeneric = isGenericEmailDomain(business.email || '');

    if (business.website_status === 'expired' && emailIsGeneric && daysUntilExpiry > -2) {
      // Too soon — wait until the day after expiry
      console.log(`    Holding — expired domain with generic email, waiting until day after expiry`);
      return false;
    }
    if (business.website_status !== 'expired' && !emailIsGeneric && daysUntilExpiry > 1) {
      // Not urgent yet — hold until one day before expiry
      console.log(`    Holding — expiring domain with custom email (${daysUntilExpiry} days away), send tomorrow`);
      return false;
    }
    if (business.website_status !== 'expired' && !emailIsGeneric && daysUntilExpiry < 0) {
      // Domain already expired — their custom email is also dead, can't reach them this way
      console.log(`    Dropping — domain expired and custom email is likely dead`);
      await updateBusiness(business.id, {
        pipeline_status: 'dropped',
        dropped_at_stage: 'outreach',
        drop_reason: 'domain_expired_email_dead',
      });
      return false;
    }
  }

  // Use stored email (from Google Places) or find one
  let email = business.email || null;
  let source = email ? 'places_api' : null;

  if (!email) {
    const found = await findEmail(business.domain, business.name);
    email = found.email;
    source = found.source;
  }

  if (!email) {
    console.log(`    No email found for ${business.domain} — skipping`);
    await updateBusiness(business.id, {
      pipeline_status: 'dropped',
      dropped_at_stage: 'outreach',
      drop_reason: 'no_email_found',
    });
    return false;
  }

  const emailType = isGenericEmailDomain(email) ? 'generic' : 'business';
  if (emailType === 'generic') {
    console.log(`    Email: ${email} (source: ${source}) ★ GENERIC — direct to owner`);
  } else {
    console.log(`    Email: ${email} (source: ${source})`);
  }

  const previewUrl = business.preview_url || null;

  // Generate personalised email body
  const body = await generateEmail(
    {
      name: business.name,
      category: business.category,
      location: business.location,
      domain: business.domain,
      website_status: business.website_status,
      whois_expiry_date: business.whois_expiry_date || null,
      google_rating: business.google_rating,
      review_count: business.review_count,
      price: BASE_PRICE,
    },
    previewUrl
  );

  const subject = buildSubject(business);

  const { messageId, etherealUrl } = await sendOutreachEmail({
    to: email,
    subject,
    body,
    previewUrl,
    screenshotPath: business.template_screenshot,
  });

  await updateBusiness(business.id, {
    email,
    email_type: emailType,
    email_source: source,
    pipeline_status: 'emailed',
    first_email_sent_at: new Date().toISOString(),
    outreach_message_id: messageId || null,  // stored for In-Reply-To matching
  });

  await logInteraction(
    business.id,
    'email_sent',
    'outbound',
    `Outreach sent to ${email}. Subject: ${subject}`,
    body,
    { messageId, etherealUrl, emailSource: source, previewUrl }
  );

  console.log(`    ✓ Sent to ${email}`);
  return true;
}

function buildSubject(business) {
  const templates = [
    `I built a website for ${business.name}`,
    `Quick one — I made a website for you`,
    `${business.name} — I built something for you`,
  ];
  // Rotate subject lines to avoid pattern detection
  const index = business.name.length % templates.length;
  return templates[index];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
