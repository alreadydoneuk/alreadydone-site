import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { findEmailFromDirectories } from '/home/brantley/alreadydone/lib/directory-finder.js';
import { isGenericEmailDomain } from '/home/brantley/alreadydone/lib/email-finder.js';
import { writeFileSync, appendFileSync } from 'fs';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const LOG = '/tmp/enrich_results.log';
writeFileSync(LOG, `Enrichment run started: ${new Date().toISOString()}\n\n`);

const log = (msg) => {
  appendFileSync(LOG, msg + '\n');
  console.log(msg);
};

const { data: businesses } = await supabase
  .from('businesses')
  .select('id, name, category, location, phone, postcode')
  .eq('website_status', 'none')
  .is('email_confidence', null)
  .order('phone', { ascending: false, nullsFirst: false }) // phone-having first
  .limit(792);

log(`Processing ${businesses.length} businesses\n`);

let found = 0, phoneOnly = 0, nothing = 0, total = 0;
const hits = [];

for (const b of businesses) {
  total++;
  const result = await findEmailFromDirectories(b);

  if (result) {
    const emailType = isGenericEmailDomain(result.email) ? 'generic' : 'business';
    const temp = result.confidence === 'high' ? 'hot' : 'warm';
    await supabase.from('businesses').update({
      email: result.email, email_type: emailType,
      email_confidence: result.confidence, email_source: result.source,
      lead_temperature: temp, outreach_route: 'email', is_prospect: true,
    }).eq('id', b.id);
    hits.push(`  ${b.name} (${b.category}) → ${result.email} [${result.confidence}]`);
    log(`✓ ${b.name} → ${result.email} [${result.confidence}]`);
    found++;
  } else {
    await supabase.from('businesses').update({
      email_confidence: 'low',
      outreach_route: b.phone ? 'phone' : null,
    }).eq('id', b.id);
    if (b.phone) phoneOnly++; else nothing++;
  }

  // Progress every 50
  if (total % 50 === 0) {
    log(`\n--- Progress: ${total}/${businesses.length} | Emails: ${found} (${Math.round(found/total*100)}%) ---\n`);
  }

  await new Promise(r => setTimeout(r, 1000));
}

log(`\n${'═'.repeat(50)}`);
log(`FINAL: ${businesses.length} processed`);
log(`Emails found:  ${found} (${Math.round(found/businesses.length*100)}%)`);
log(`Phone only:    ${phoneOnly}`);
log(`No route:      ${nothing}`);
log(`\nAll emails found:`);
hits.forEach(h => log(h));
log(`\nCompleted: ${new Date().toISOString()}`);
