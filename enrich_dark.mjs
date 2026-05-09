import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { findEmailFromDirectories, lookupWhois } from '/home/brantley/alreadydone/lib/directory-finder.js';
import { isGenericEmailDomain } from '/home/brantley/alreadydone/lib/email-finder.js';
import { writeFileSync, appendFileSync } from 'fs';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const LOG = '/tmp/enrich_dark_results.log';
writeFileSync(LOG, `Dark cohort enrichment started: ${new Date().toISOString()}\n\n`);

const log = (msg) => { appendFileSync(LOG, msg + '\n'); console.log(msg); };

// All Dark businesses: parked, broken, broken_dns, broken_server, coming_soon, seo_doorway
const DARK_STATUSES = ['parked', 'broken', 'broken_dns', 'broken_server', 'coming_soon', 'seo_doorway'];

const { data: businesses, error } = await supabase
  .from('businesses')
  .select('id, name, category, location, phone, postcode, domain, website_status')
  .in('website_status', DARK_STATUSES)
  .order('domain', { ascending: false, nullsFirst: false }) // domain-having first
  .limit(500);

if (error) { log('DB error: ' + error.message); process.exit(1); }

log(`Processing ${businesses.length} Dark cohort businesses\n`);
log('Status breakdown: ' + Object.entries(
  businesses.reduce((acc, b) => { acc[b.website_status] = (acc[b.website_status]||0)+1; return acc; }, {})
).map(([k,v]) => `${k}:${v}`).join(', ') + '\n');

let emailFound = 0, whoisFound = 0, nothing = 0, total = 0;
const hits = [];

for (const b of businesses) {
  total++;

  // ── WHOIS lookup (always run for Dark — free metadata regardless of email) ──
  let whoisData = null;
  if (b.domain) {
    try {
      whoisData = await lookupWhois(b.domain);
      if (whoisData) {
        whoisFound++;
        await supabase.from('businesses').update({
          whois_registrar:       whoisData.registrar || null,
          whois_registered_date: whoisData.registered_date || null,
          whois_expiry_date:     whoisData.expiry_date || null,
          whois_nameservers:     whoisData.nameservers || null,
          whois_attempted_at:    new Date().toISOString(),
        }).eq('id', b.id);
        const age = whoisData.registered_date
          ? Math.floor((Date.now() - new Date(whoisData.registered_date)) / (1000 * 60 * 60 * 24 * 365))
          : null;
        log(`  [whois] ${b.name}: ${whoisData.registrar || 'unknown registrar'}${age !== null ? `, registered ${age}yr ago` : ''}${whoisData.expiry_date ? `, expires ${whoisData.expiry_date}` : ''}`);
      }
    } catch (err) {
      log(`  [whois] ${b.name}: error — ${err.message}`);
    }
  }

  // ── Serper email search ───────────────────────────────────────────────────
  const result = await findEmailFromDirectories(b);

  if (result) {
    const emailType = isGenericEmailDomain(result.email) ? 'generic' : 'business';
    const temp = result.confidence === 'high' ? 'hot' : 'warm';
    await supabase.from('businesses').update({
      email:               result.email,
      email_type:          emailType,
      email_confidence:    result.confidence,
      email_source:        result.source,
      lead_temperature:    temp,
      outreach_route:      'email',
      serper_attempted_at: new Date().toISOString(),
    }).eq('id', b.id);
    hits.push(`  ${b.name} (${b.website_status}) → ${result.email} [${result.confidence}]`);
    log(`✓ ${b.name} → ${result.email} [${result.confidence}]`);
    emailFound++;
  } else {
    await supabase.from('businesses').update({
      email_confidence:    'low',
      outreach_route:      b.phone ? 'phone' : null,
      serper_attempted_at: new Date().toISOString(),
    }).eq('id', b.id);
    if (b.phone) nothing++;
  }

  if (total % 25 === 0) {
    log(`\n--- Progress: ${total}/${businesses.length} | Emails: ${emailFound} (${Math.round(emailFound/total*100)}%) | WHOIS: ${whoisFound} ---\n`);
  }

  await new Promise(r => setTimeout(r, 1200));
}

log(`\n${'═'.repeat(50)}`);
log(`Dark cohort enrichment complete`);
log(`Processed:     ${businesses.length}`);
log(`Emails found:  ${emailFound} (${Math.round(emailFound/businesses.length*100)}%)`);
log(`WHOIS data:    ${whoisFound} (${Math.round(whoisFound/businesses.length*100)}%)`);
log(`Phone only:    ${nothing}`);
log(`\nAll emails found:`);
hits.forEach(h => log(h));
log(`\nCompleted: ${new Date().toISOString()}`);
