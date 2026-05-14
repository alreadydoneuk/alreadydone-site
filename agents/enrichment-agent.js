import { supabase, logApiUsage } from '../lib/db.js';
import { findEmailFromDirectories, lookupWhois } from '../lib/directory-finder.js';
import { isGenericEmailDomain } from '../lib/email-finder.js';
import { checkDomain } from '../lib/parked.js';
import { findBusinessWebsite } from '../lib/serper-enricher.js';
import { alert } from '../lib/slack.js';
import 'dotenv/config';

// ── Email validation helpers ────────────────────────────────────────────────

const PLACEHOLDER_EMAIL_PATTERNS = [
  /^your@/, /^test@/, /^example@/, /^email@email/, /^noreply@/, /^no-reply@/, /^info@info/, /^admin@admin/,
  /^customerservice@/, /^customercare@/, /^careers@/, /^jobs@/, /^recruitment@/,
  /u00[0-9a-f]{2}/i,  // HTML-encoded chars in local part (u002f = /, u0040 = @, etc.)
];
const isPlaceholderEmail = email => PLACEHOLDER_EMAIL_PATTERNS.some(p => p.test(email.toLowerCase()));

const INSTITUTIONAL_PATTERNS = [/@nhs\.(net|scot|uk)$/i, /@.*\.gov\.uk$/i, /@.*\.ac\.uk$/i];
const isInstitutionalEmail = e => INSTITUTIONAL_PATTERNS.some(p => p.test(e));

const NAME_NOISE = new Set(['the','and','of','in','at','for','ltd','limited','llp','llc','plc','inc','co','services','solutions','group','uk','scotland','edinburgh']);

// Returns a rejection reason string, or null if email looks plausible for this business.
function rejectEmail(email, businessName, category) {
  if (isPlaceholderEmail(email)) return 'placeholder';
  if (isInstitutionalEmail(email)) return 'institutional (NHS/gov/ac)';
  if (isGenericEmailDomain(email)) return null; // generic domains (gmail etc) are always fine

  const domain = (email.split('@')[1] || '').replace(/\.(co\.uk|com|net|org|uk|biz|info|trade|scot)$/, '').toLowerCase();
  const nameWords = (businessName + ' ' + (category || ''))
    .toLowerCase()
    .split(/[\s&\-_.,()\/]+/)
    .filter(w => w.length >= 4 && !NAME_NOISE.has(w));

  if (nameWords.length === 0) return null;

  const hasOverlap = nameWords.some(w => {
    if (domain.includes(w)) return true;
    if (w.length >= 7 && domain.includes(w.slice(0, 5))) return true;
    return false;
  });

  return hasOverlap ? null : `domain mismatch: "${domain}" vs "${businessName}"`;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DARK_STATUSES = ['parked', 'broken', 'broken_dns', 'broken_server', 'coming_soon', 'seo_doorway'];
const GHOST_STATUSES = ['none', 'social'];

// ── Blocklist loader ─────────────────────────────────────────────────────────

export async function loadBlocklist() {
  const { data, error } = await supabase.from('email_blocklist').select('email');
  if (error) {
    console.warn('  [blocklist] Could not load email_blocklist:', error.message);
    return new Set();
  }
  return new Set(data.map(r => r.email));
}

// ── Single-business enrichment ───────────────────────────────────────────────
// Used both by the batch agent and inline from research-agent.
// Returns 'enriched' | 'rejected' | 'not_found' | 'phone_only'.

export async function enrichOneBusiness(business, blocklist) {
  const isDark = DARK_STATUSES.includes(business.website_status);

  // ── Step 1: Active website detection ──────────────────────────────────────
  // Search for the business by name and location. If Serper finds their own website
  // in the results, check whether it's live. If it is, exclude immediately.
  // This runs before WHOIS and email search — no point spending those credits
  // on a business that already has a working site.
  const foundUrl = await findBusinessWebsite(business);
  if (foundUrl) {
    const domainStatus = await checkDomain(foundUrl);
    if (domainStatus === 'live') {
      let hostname;
      try { hostname = new URL(foundUrl).hostname.replace(/^www\./, ''); } catch { hostname = foundUrl; }
      console.log(`    ✗ Live site found via Serper: ${foundUrl} — excluding`);
      await supabase.from('businesses').update({
        domain:              hostname,
        website_status:      'live',
        is_prospect:         false,
        pipeline_status:     'excluded',
        serper_attempted_at: new Date().toISOString(),
      }).eq('id', business.id);
      await supabase.from('interactions').insert({
        business_id:     business.id,
        type:            'skip',
        direction:       'internal',
        content_summary: `Live website discovered at enrichment via Serper: ${foundUrl}`,
        metadata:        { foundUrl, domainStatus },
      });
      return 'live_site';
    }
    console.log(`    [website-check] ${foundUrl} → ${domainStatus} (not live, continuing)`);
  }

  // ── Step 2: WHOIS for Dark businesses (free metadata, run regardless of email result) ──
  if (isDark && business.domain) {
    const whoisData = await lookupWhois(business.domain);
    if (whoisData) {
      const expiryDate = whoisData.expiry_date ? new Date(whoisData.expiry_date) : null;
      const recentlyExpired = expiryDate && expiryDate < new Date() &&
        expiryDate > new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

      await supabase.from('businesses').update({
        whois_registrar:       whoisData.registrar || null,
        whois_registered_date: whoisData.registered_date || null,
        whois_expiry_date:     whoisData.expiry_date || null,
        whois_nameservers:     whoisData.nameservers || null,
        whois_attempted_at:    new Date().toISOString(),
        lead_temperature:      recentlyExpired ? 'hot' : undefined,
      }).eq('id', business.id);

      const age = whoisData.registered_date
        ? Math.floor((Date.now() - new Date(whoisData.registered_date)) / (365.25 * 24 * 60 * 60 * 1000))
        : null;
      console.log(`    [whois] ${whoisData.registrar || 'unknown'}, ${age !== null ? age + 'yr' : 'unknown age'}${recentlyExpired ? ' ⚠️ RECENTLY EXPIRED' : ''}`);
    } else {
      await supabase.from('businesses').update({ whois_attempted_at: new Date().toISOString() }).eq('id', business.id);
    }
  }

  // ── Serper email search ────────────────────────────────────────────────────
  const result = await findEmailFromDirectories(business);

  if (result && !blocklist.has(result.email)) {
    const rejection = rejectEmail(result.email, business.name, business.category);
    if (rejection) {
      console.log(`    ✗ Rejected (${rejection}): ${result.email}`);
      await supabase.from('businesses').update({ serper_attempted_at: new Date().toISOString() }).eq('id', business.id);
      await supabase.from('interactions').insert({
        business_id:     business.id,
        type:            'skip',
        direction:       'internal',
        content_summary: `Email rejected at enrichment (${rejection}): ${result.email}`,
        metadata:        { email: result.email, source: result.source, rejection },
      });
      return 'rejected';
    }

    const emailType = isGenericEmailDomain(result.email) ? 'generic' : 'business';

    // Business-domain email means we now have the domain — check if there's a live site there.
    // This is the most common way a social/ghost business slips through: Google Places lists their
    // Facebook page, so we never check their real domain. The email address hands it to us for free.
    if (emailType === 'business') {
      const emailDomain = result.email.split('@')[1];
      console.log(`    [domain-check] Checking ${emailDomain} from email domain...`);
      const domainStatus = await checkDomain(`https://${emailDomain}`);
      if (domainStatus === 'live') {
        console.log(`    ✗ Live site found at email domain ${emailDomain} — excluding`);
        await supabase.from('businesses').update({
          domain:              emailDomain,
          website_status:      'live',
          is_prospect:         false,
          pipeline_status:     'excluded',
          serper_attempted_at: new Date().toISOString(),
        }).eq('id', business.id);
        await supabase.from('interactions').insert({
          business_id:     business.id,
          type:            'skip',
          direction:       'internal',
          content_summary: `Live website found at email domain ${emailDomain} — excluded`,
          metadata:        { email: result.email, emailDomain, domainStatus },
        });
        return 'live_site';
      }
      console.log(`    [domain-check] ${emailDomain} → ${domainStatus} (not live, continuing)`);
    }
    const newTemperature = result.confidence === 'high' ? 'hot' : 'warm';

    await supabase.from('businesses').update({
      email:               result.email,
      email_type:          emailType,
      email_confidence:    result.confidence,
      email_source:        result.source,
      lead_temperature:    newTemperature,
      pipeline_status:     'researched',
      outreach_route:      'email',
      is_prospect:         true,
      serper_attempted_at: new Date().toISOString(),
    }).eq('id', business.id);

    await supabase.from('interactions').insert({
      business_id:     business.id,
      type:            'email_enriched',
      direction:       'internal',
      content_summary: `Email found via ${result.source}: ${result.email} [${result.confidence}]`,
      metadata:        { source: result.source, profileUrl: result.profileUrl, confidence: result.confidence },
    });

    console.log(`    ✓ ${result.email} [${result.confidence}] via ${result.source} → ${newTemperature}`);
    return 'enriched';
  }

  // No email found (or blocklisted)
  if (result) console.log(`    ✗ Blocked: ${result.email}`);
  await supabase.from('businesses').update({
    email_confidence:    'low',
    outreach_route:      business.phone ? 'phone' : null,
    serper_attempted_at: new Date().toISOString(),
  }).eq('id', business.id);

  if (business.phone) { console.log(`    → Phone only`); return 'phone_only'; }
  console.log(`    → No contact route`);
  return 'not_found';
}

// ── Batch agent (catch-up / re-enrichment) ───────────────────────────────────
// Runs daily as a safety net for anything not enriched inline at research time.
// Drains the full queue when drainAll=true (for backlog processing).

export async function runEnrichmentAgent({ drainAll = false } = {}) {
  const blocklist = await loadBlocklist();
  console.log(`  [blocklist] ${blocklist.size} blocked emails loaded`);

  let totalEnriched = 0, totalWhois = 0, totalPhoneOnly = 0, totalAttempted = 0;
  let round = 0;

  do {
    round++;
    const BATCH_SIZE = drainAll ? 200 : 50;

    const { data: darkBatch } = await supabase
      .from('businesses')
      .select('id, name, category, location, phone, postcode, domain, website_status')
      .in('website_status', DARK_STATUSES)
      .is('serper_attempted_at', null)
      .is('email', null)
      .order('domain', { ascending: false, nullsFirst: false })
      .limit(drainAll ? BATCH_SIZE : Math.floor(BATCH_SIZE * 0.4));

    const { data: ghostBatch } = await supabase
      .from('businesses')
      .select('id, name, category, location, phone, postcode, domain, website_status')
      .in('website_status', GHOST_STATUSES)
      .is('serper_attempted_at', null)
      .is('email', null)
      .order('phone', { ascending: false, nullsFirst: false })
      .limit(drainAll ? BATCH_SIZE : Math.floor(BATCH_SIZE * 0.6));

    const businesses = [...(darkBatch || []), ...(ghostBatch || [])];

    if (!businesses.length) {
      if (round === 1) console.log('Enrichment: queue empty');
      break;
    }

    const darkCount = (darkBatch || []).length;
    const ghostCount = (ghostBatch || []).length;
    console.log(`\n${drainAll ? `[Round ${round}] ` : ''}Enriching ${businesses.length} businesses (${darkCount} Dark, ${ghostCount} Ghost)`);

    for (const business of businesses) {
      console.log(`\n  ${business.name} (${business.category}, ${business.website_status})`);
      try {
        const outcome = await enrichOneBusiness(business, blocklist);
        totalAttempted++;
        if (outcome === 'enriched') totalEnriched++;
        if (outcome === 'phone_only') totalPhoneOnly++;
      } catch (err) {
        console.error(`    Error enriching ${business.name}: ${err.message}`);
      }
      await sleep(2000);
    }

    // Log Serper usage for this round
    const searches = businesses.length * 3;
    await logApiUsage('serper', searches, searches * 0.001, {
      agent: 'enrichment-agent',
      notes: `${businesses.length} businesses (round ${round})`,
    });

  } while (drainAll);

  console.log(`\nEnrichment complete: ${totalEnriched} emails found, ${totalPhoneOnly} phone-only, ${totalAttempted} attempted\n`);

  await detectAndRemoveFalsePositives(blocklist);

  return { enriched: totalEnriched, phoneOnly: totalPhoneOnly, attempted: totalAttempted };
}

// ── False-positive detector ──────────────────────────────────────────────────

async function detectAndRemoveFalsePositives(currentBlocklist) {
  const { data } = await supabase
    .from('businesses')
    .select('email')
    .not('email', 'is', null)
    .limit(10000);

  if (!data?.length) return;

  const counts = {};
  for (const { email } of data) {
    if (!currentBlocklist.has(email)) {
      counts[email] = (counts[email] || 0) + 1;
    }
  }

  const newFalsePositives = Object.entries(counts)
    .filter(([email, count]) => count >= 3 && !/@(gmail|hotmail|yahoo|outlook|icloud|live|me|aol)\./i.test(email))
    .sort((a, b) => b[1] - a[1]);

  if (!newFalsePositives.length) return;

  console.log(`\n  [blocklist] Auto-removing ${newFalsePositives.length} false positive(s):`);

  const removed = [];

  for (const [email, count] of newFalsePositives) {
    await supabase.from('email_blocklist').upsert({
      email,
      reason: 'frequency_detection',
      occurrences: count,
      blocked_at: new Date().toISOString(),
    }, { onConflict: 'email' });

    const { data: cleared } = await supabase
      .from('businesses')
      .update({
        email:               null,
        email_confidence:    null,
        email_source:        null,
        email_type:          null,
        serper_attempted_at: null,
      })
      .eq('email', email)
      .select('name');

    const names = cleared?.map(b => b.name).join(', ') || '';
    console.log(`    ✗ ${count}x ${email} — removed from: ${names}`);
    removed.push({ email, count, names });
  }

  const summary = removed.map(r => `${r.count}x ${r.email}\n  removed from: ${r.names}`).join('\n\n');
  await alert(
    `🧹 Enrichment auto-removed ${removed.length} false positive email(s)`,
    `Frequency detector found emails stored across 3+ unrelated businesses. Removed and flagged for re-enrichment automatically.\n\`\`\`\n${summary}\n\`\`\``
  ).catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
