import { supabase, logApiUsage } from '../lib/db.js';
import { findEmailFromDirectories, lookupWhois } from '../lib/directory-finder.js';
import { isGenericEmailDomain } from '../lib/email-finder.js';
import { alert } from '../lib/slack.js';
import 'dotenv/config';

// Enrichment agent: finds contact emails for Ghost and Dark cohort businesses.
// Ghost (none/social): no domain — Serper only.
// Dark (parked/broken/etc): domain exists — WHOIS first (free metadata), then Serper.
// Runs 3x/day. Upgrades confirmed matches so outreach agent picks them up.

const BATCH_SIZE = 50;

const DARK_STATUSES = ['parked', 'broken', 'broken_dns', 'broken_server', 'coming_soon', 'seo_doorway'];
const GHOST_STATUSES = ['none', 'social'];

async function loadBlocklist() {
  const { data, error } = await supabase.from('email_blocklist').select('email');
  if (error) {
    // Table may not exist yet — fail open so enrichment still runs
    console.warn('  [blocklist] Could not load email_blocklist:', error.message);
    return new Set();
  }
  return new Set(data.map(r => r.email));
}

export async function runEnrichmentAgent() {
  const blocklist = await loadBlocklist();
  console.log(`  [blocklist] ${blocklist.size} blocked emails loaded`);

  // Skip businesses that already have a confirmed email — no point re-running Serper.
  // Also catches Ghost businesses enriched before serper_attempted_at column existed
  // (their field is null but they already have a valid email from an earlier run).
  const { data: darkBatch } = await supabase
    .from('businesses')
    .select('id, name, category, location, phone, postcode, domain, website_status')
    .in('website_status', DARK_STATUSES)
    .is('serper_attempted_at', null)
    .is('email', null)
    .order('domain', { ascending: false, nullsFirst: false })
    .limit(Math.floor(BATCH_SIZE * 0.4));

  const { data: ghostBatch } = await supabase
    .from('businesses')
    .select('id, name, category, location, phone, postcode, domain, website_status')
    .in('website_status', GHOST_STATUSES)
    .is('email', null)
    .order('phone', { ascending: false, nullsFirst: false })
    .limit(Math.floor(BATCH_SIZE * 0.6));

  const businesses = [...(darkBatch || []), ...(ghostBatch || [])];

  if (!businesses.length) {
    console.log('Enrichment: no unenriched businesses in either cohort');
    return { enriched: 0, whoisFound: 0, phoneOnly: 0 };
  }

  const darkCount = (darkBatch || []).length;
  const ghostCount = (ghostBatch || []).length;
  console.log(`\nEnrichment: ${businesses.length} businesses (${darkCount} Dark, ${ghostCount} Ghost)`);

  let enriched = 0, whoisFound = 0, phoneOnly = 0;

  for (const business of businesses) {
    const isDark = DARK_STATUSES.includes(business.website_status);
    console.log(`\n  ${business.name} (${business.category}, ${business.website_status})`);

    try {
      // ── WHOIS for Dark businesses (free, always run regardless of email result) ──
      if (isDark && business.domain) {
        const whoisData = await lookupWhois(business.domain);
        if (whoisData) {
          whoisFound++;
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
          console.log(`    [whois] ${whoisData.registrar || 'unknown'}, registered ${age !== null ? age + 'yr ago' : 'unknown'}${recentlyExpired ? ' ⚠️ RECENTLY EXPIRED' : ''}`);
        } else {
          await supabase.from('businesses').update({ whois_attempted_at: new Date().toISOString() }).eq('id', business.id);
        }
      }

      // ── Serper email search ─────────────────────────────────────────────────
      const result = await findEmailFromDirectories(business);

      if (result && !blocklist.has(result.email)) {
        const emailType = isGenericEmailDomain(result.email) ? 'generic' : 'business';
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
        enriched++;
      } else {
        if (result) console.log(`    ✗ Blocked: ${result.email}`);
        await supabase.from('businesses').update({
          email_confidence:    'low',
          outreach_route:      business.phone ? 'phone' : null,
          serper_attempted_at: new Date().toISOString(),
        }).eq('id', business.id);

        if (business.phone) { console.log(`    → Phone only`); phoneOnly++; }
        else                 { console.log(`    → No contact route`); }
      }
    } catch (err) {
      console.error(`    Error enriching ${business.name}: ${err.message}`);
    }

    await sleep(2000);
  }

  console.log(`\nEnrichment complete: ${enriched} emails, ${whoisFound} WHOIS records, ${phoneOnly} phone-only\n`);

  // Serper: ~3 searches/business attempted @ $0.001/search = $0.003/business
  const totalAttempted = (darkBatch?.length || 0) + (ghostBatch?.length || 0);
  const serperSearches = totalAttempted * 3;
  await logApiUsage('serper', serperSearches, serperSearches * 0.001, {
    agent: 'enrichment-agent',
    notes: `${totalAttempted} businesses enriched (${enriched} found)`,
  });

  await detectAndRemoveFalsePositives(blocklist);

  return { enriched, whoisFound, phoneOnly };
}

async function detectAndRemoveFalsePositives(currentBlocklist) {
  // Load all stored emails across the entire DB (not just this batch)
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

  // Non-generic-domain emails appearing on 3+ businesses = cross-contamination
  const newFalsePositives = Object.entries(counts)
    .filter(([email, count]) => count >= 3 && !/@(gmail|hotmail|yahoo|outlook|icloud|live|me|aol)\./i.test(email))
    .sort((a, b) => b[1] - a[1]);

  if (!newFalsePositives.length) return;

  console.log(`\n  [blocklist] Auto-removing ${newFalsePositives.length} false positive(s):`);

  const removed = [];

  for (const [email, count] of newFalsePositives) {
    // Add to DB block list so future runs skip it immediately
    await supabase.from('email_blocklist').upsert({
      email,
      reason: 'frequency_detection',
      occurrences: count,
      blocked_at: new Date().toISOString(),
    }, { onConflict: 'email' });

    // Remove from all businesses and reset for re-enrichment
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

  // Confirm what was done — no action needed from anyone
  const summary = removed.map(r => `${r.count}x ${r.email}\n  removed from: ${r.names}`).join('\n\n');
  await alert(
    `🧹 Enrichment auto-removed ${removed.length} false positive email(s)`,
    `Frequency detector found emails stored across 3+ unrelated businesses. Removed and flagged for re-enrichment automatically.\n\`\`\`\n${summary}\n\`\`\``
  ).catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
