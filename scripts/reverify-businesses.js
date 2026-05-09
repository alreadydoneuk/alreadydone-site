// Re-checks every business in the database and removes any that now resolve as live.
// Run this from your terminal after updating the parked domain checker.
// Usage: node scripts/reverify-businesses.js

import { supabase } from '../lib/db.js';
import { checkDomain } from '../lib/parked.js';
import 'dotenv/config';

const { data: businesses, error } = await supabase
  .from('businesses')
  .select('id, name, domain, website_status')
  .in('pipeline_status', ['researched', 'template_built']); // only pre-outreach stages

if (error) throw error;
if (!businesses?.length) { console.log('No businesses to re-verify'); process.exit(0); }

console.log(`Re-verifying ${businesses.length} businesses...\n`);

let removed = 0, updated = 0, confirmed = 0;

for (const biz of businesses) {
  if (!biz.domain) continue;

  const newStatus = await checkDomain(`https://${biz.domain}`);
  const icon = {
    live: '✅', parked: '🅿️ ', broken: '❌', none: '—',
    broken_server: '🔴', broken_dns: '⚫', coming_soon: '🟡', social: '📱',
  }[newStatus] || '❓';
  console.log(`${icon} [${newStatus.padEnd(6)}] ${biz.name} — ${biz.domain}`);

  if (newStatus === 'coming_soon') {
    await supabase.from('businesses').update({ website_status: 'coming_soon', tier: 1 }).eq('id', biz.id);
    console.log(`         ↳ Updated to coming_soon (high value lead — site placeholder only)`);
    updated++;
  } else if (newStatus === 'live') {
    // Remove — they have a working site, not a lead
    await supabase.from('businesses').delete().eq('id', biz.id);
    console.log(`         ↳ Removed (has live site)`);
    removed++;
  } else if (newStatus !== biz.website_status) {
    // Status changed (e.g. broken → parked) — update
    await supabase.from('businesses').update({ website_status: newStatus }).eq('id', biz.id);
    console.log(`         ↳ Updated: ${biz.website_status} → ${newStatus}`);
    updated++;
  } else {
    confirmed++;
  }

  await new Promise(r => setTimeout(r, 400));
}

console.log(`\nDone. Removed: ${removed} | Updated: ${updated} | Confirmed: ${confirmed}`);
