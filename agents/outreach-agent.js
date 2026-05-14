import { getBusinessesByStatus, updateBusiness, logInteraction } from '../lib/db.js';
import { generateEmail } from '../lib/claude.js';
import { findEmail, isGenericEmailDomain } from '../lib/email-finder.js';
import { sendOutreachEmail } from '../lib/mailer.js';
import { isEmailable } from '../lib/parked.js';
import 'dotenv/config';

const PLACEHOLDER_EMAIL_PATTERNS = [/^your@/, /^test@/, /^example@/, /^email@email/, /^noreply@/, /^no-reply@/];
const isPlaceholderEmail = email => PLACEHOLDER_EMAIL_PATTERNS.some(p => p.test(email.toLowerCase()));

const INSTITUTIONAL_PATTERNS = [/@nhs\.(net|scot|uk)$/i, /@.*\.gov\.uk$/i, /@.*\.ac\.uk$/i];
const isInstitutionalEmail = e => INSTITUTIONAL_PATTERNS.some(p => p.test(e));

const NAME_NOISE = new Set(['the','and','of','in','at','for','ltd','limited','llp','llc','plc','inc','co','services','solutions','group','uk','scotland','edinburgh']);

function emailDomainMismatch(email, name, category) {
  if (isGenericEmailDomain(email)) return null;
  if (isPlaceholderEmail(email)) return 'placeholder';
  if (isInstitutionalEmail(email)) return 'institutional email (NHS/gov/ac) — not the business owner';
  const domain = (email.split('@')[1] || '').replace(/\.(co\.uk|com|net|org|uk|biz|info|trade|scot)$/, '').toLowerCase();
  const nameWords = (name + ' ' + category).toLowerCase().split(/[\s&\-_.,()\/]+/).filter(w => w.length >= 4 && !NAME_NOISE.has(w));
  if (nameWords.length === 0) return null;
  const hasOverlap = nameWords.some(w => {
    if (domain.includes(w)) return true;
    if (w.length >= 7 && domain.includes(w.slice(0, 5))) return true;
    return false;
  });
  return hasOverlap ? null : `domain mismatch: "${domain}" vs "${name}"`;
}

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

export async function sendOutreachForBusiness(business) {
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

  // Expiry timing gate — only applies to parked/coming_soon where urgency is tied to renewal date.
  // broken_server/broken means the site is down for other reasons, not expiry — send immediately.
  const expiryGatedStatuses = ['parked', 'coming_soon'];
  if (business.whois_expiry_date && expiryGatedStatuses.includes(business.website_status)) {
    const expiry = new Date(business.whois_expiry_date);
    expiry.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daysUntilExpiry = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
    const emailIsGeneric = isGenericEmailDomain(business.email || '');

    if (!emailIsGeneric && daysUntilExpiry > 1) {
      // Custom domain email — hold until one day before expiry so we land at peak urgency
      console.log(`    Holding — parked domain with custom email (${daysUntilExpiry} days until expiry)`);
      return false;
    }
    if (!emailIsGeneric && daysUntilExpiry < 0) {
      // Domain already expired — custom email is dead
      console.log(`    Dropping — domain expired and custom email is likely dead`);
      await updateBusiness(business.id, {
        pipeline_status: 'dropped',
        dropped_at_stage: 'outreach',
        drop_reason: 'domain_expired_email_dead',
      });
      return false;
    }
  }
  // Separate gate for expired domains with generic email — wait until day after expiry
  if (business.website_status === 'expired' && business.whois_expiry_date) {
    const expiry = new Date(business.whois_expiry_date);
    expiry.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daysUntilExpiry = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
    const emailIsGeneric = isGenericEmailDomain(business.email || '');
    if (emailIsGeneric && daysUntilExpiry > -2) {
      console.log(`    Holding — expired domain with generic email, waiting until day after expiry`);
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

  // broken_dns + custom domain email: DNS is fully gone so the @domain address is unreachable
  if (business.website_status === 'broken_dns' && emailType !== 'generic') {
    console.log(`    Dropping — broken_dns with custom domain email (${email}) — unreachable`);
    await updateBusiness(business.id, {
      pipeline_status: 'dropped',
      dropped_at_stage: 'outreach',
      drop_reason: 'broken_dns_email_dead',
    });
    return false;
  }

  // Email domain sanity check — catch placeholder and mismatched emails from Google Places
  const mismatch = emailDomainMismatch(email, business.name, business.category);
  if (mismatch) {
    console.log(`    Dropping — ${mismatch}`);
    await updateBusiness(business.id, {
      pipeline_status: 'dropped',
      dropped_at_stage: 'outreach',
      drop_reason: 'email_domain_mismatch',
    });
    return false;
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
    { messageId, etherealUrl, emailSource: source, previewUrl, subject }
  );

  console.log(`    ✓ Sent to ${email}`);
  return true;
}

function buildSubject(business) {
  const s = business.website_status;
  const domain = business.domain || business.name;
  const rotate = (arr) => arr[business.name.length % arr.length];

  if (s === 'expired') {
    return rotate([
      `Your domain has expired — quick heads up`,
      `${domain} — just wanted to flag this`,
      `Noticed your site is down`,
    ]);
  }

  if (business.whois_expiry_date) {
    const days = Math.ceil((new Date(business.whois_expiry_date) - new Date()) / (1000 * 60 * 60 * 24));
    if (days <= 1 && s !== 'expired') {
      return rotate([
        `${domain} — expires tomorrow`,
        `Quick heads up about your domain`,
        `Your domain and email go dark tomorrow`,
      ]);
    }
  }

  if (s === 'broken_server') {
    return rotate([
      `Your website isn't loading`,
      `Spotted a problem with ${domain}`,
      `Quick heads up about your site`,
    ]);
  }

  if (s === 'broken') {
    return rotate([
      `Something's wrong with your website`,
      `Quick heads up — your site has an issue`,
      `Noticed a problem with ${domain}`,
    ]);
  }

  if (s === 'coming_soon') {
    return rotate([
      `I finished your website`,
      `Picked up where you left off on ${domain}`,
      `Your coming soon page — I went ahead and finished it`,
    ]);
  }

  // parked, none, social, seo_doorway, etc.
  return rotate([
    `Had a look at your Google listing`,
    `Built something for ${business.name}`,
    `Quick question about ${business.name}`,
  ]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
