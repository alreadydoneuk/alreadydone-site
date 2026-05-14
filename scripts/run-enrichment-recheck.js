// Re-check businesses that were processed before website detection was added.
// Runs findBusinessWebsite() + email domain check on every ghost/social business
// that has already been through enrichment but was never checked for a live site.
import { supabase } from '../lib/db.js';
import { checkDomain } from '../lib/parked.js';
import { findBusinessWebsite } from '../lib/serper-enricher.js';
import { isGenericEmailDomain } from '../lib/email-finder.js';

const GHOST_STATUSES = ['none', 'social'];

console.log('=== Enrichment Re-check (Website Detection) ===');
console.log('Re-checking all previously enriched ghost businesses for live websites...\n');

const { data: businesses } = await supabase
  .from('businesses')
  .select('id, name, category, location, domain, website_status, email, pipeline_status')
  .in('website_status', GHOST_STATUSES)
  .not('serper_attempted_at', 'is', null)
  .neq('pipeline_status', 'excluded')
  .neq('pipeline_status', 'emailed')
  .order('created_at', { ascending: false });

if (!businesses?.length) {
  console.log('No businesses to re-check.');
  process.exit(0);
}

console.log(`Re-checking ${businesses.length} businesses...\n`);

let excluded = 0, clean = 0;

for (const business of businesses) {
  console.log(`\n  ${business.name} (${business.category}, ${business.website_status})`);

  let liveUrl = null;

  // Check 1: Serper website search
  try {
    const foundUrl = await findBusinessWebsite(business);
    if (foundUrl) {
      const status = await checkDomain(foundUrl);
      if (status === 'live') {
        liveUrl = foundUrl;
        console.log(`    ✗ Live site found via Serper: ${foundUrl}`);
      } else {
        console.log(`    [website-check] ${foundUrl} → ${status}`);
      }
    }
  } catch (err) {
    console.error(`    [website-check error] ${err.message}`);
  }

  // Check 2: Email domain (only if Serper didn't already find a live site)
  if (!liveUrl && business.email && !isGenericEmailDomain(business.email)) {
    const emailDomain = business.email.split('@')[1];
    try {
      const status = await checkDomain(`https://${emailDomain}`);
      if (status === 'live') {
        liveUrl = `https://${emailDomain}`;
        console.log(`    ✗ Live site found at email domain: ${emailDomain}`);
      } else {
        console.log(`    [domain-check] ${emailDomain} → ${status}`);
      }
    } catch (err) {
      console.error(`    [domain-check error] ${err.message}`);
    }
  }

  if (liveUrl) {
    let hostname;
    try { hostname = new URL(liveUrl).hostname.replace(/^www\./, ''); } catch { hostname = liveUrl; }

    await supabase.from('businesses').update({
      domain:          hostname,
      website_status:  'live',
      is_prospect:     false,
      pipeline_status: 'excluded',
    }).eq('id', business.id);

    await supabase.from('interactions').insert({
      business_id:     business.id,
      type:            'skip',
      direction:       'internal',
      content_summary: `Live website found on re-check: ${liveUrl}`,
      metadata:        { liveUrl, hostname },
    });

    excluded++;
    console.log(`    → Excluded`);
  } else {
    clean++;
    console.log(`    → No live site found — remains as prospect`);
  }

  await sleep(1500);
}

console.log(`\n=== Re-check complete: ${excluded} excluded, ${clean} confirmed clean ===\n`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
