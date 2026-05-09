// Dry-run enrichment test — reads from DB, never writes back.
// Pulls 20 no-website businesses and tests directory finder hit rate.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { findEmailFromDirectories } from '../lib/directory-finder.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data: businesses } = await supabase
  .from('businesses')
  .select('id, name, category, location, address, phone, postcode')
  .eq('website_status', 'none')
  .not('phone', 'is', null)   // phone first — highest confidence matches
  .limit(12);

const { data: noPhone } = await supabase
  .from('businesses')
  .select('id, name, category, location, address, phone, postcode')
  .eq('website_status', 'none')
  .is('phone', null)
  .limit(8);

const all = [...(businesses || []), ...(noPhone || [])];

console.log(`\n=== Enrichment Test — ${all.length} businesses ===`);
console.log(`${businesses?.length || 0} with phone | ${noPhone?.length || 0} without phone\n`);

const results = { high: [], medium: [], notFound: [], errors: [] };

for (const b of all) {
  const phoneTag = b.phone ? ` [📞 ${b.phone}]` : ' [no phone]';
  console.log(`\n──────────────────────────────────────`);
  console.log(`${b.name} — ${b.category}, ${b.location}${phoneTag}`);

  try {
    const result = await findEmailFromDirectories(b);
    if (result) {
      const tag = result.confidence === 'high' ? '★★ HIGH' : '★ MEDIUM';
      console.log(`  ✓ ${tag} | ${result.email} | via ${result.source}`);
      results[result.confidence].push({ ...b, ...result });
    } else {
      console.log(`  ✗ Not found`);
      results.notFound.push(b);
    }
  } catch (err) {
    console.log(`  ⚠ Error: ${err.message}`);
    results.errors.push({ ...b, error: err.message });
  }
}

const total = all.length;
const found = results.high.length + results.medium.length;

console.log(`\n${'═'.repeat(50)}`);
console.log(`RESULTS — ${found}/${total} emails found (${Math.round(found/total*100)}% hit rate)`);
console.log(`  ★★ High confidence : ${results.high.length}`);
console.log(`  ★  Medium confidence: ${results.medium.length}`);
console.log(`  ✗  Not found       : ${results.notFound.length}`);
console.log(`  ⚠  Errors          : ${results.errors.length}`);

if (results.high.length + results.medium.length > 0) {
  console.log(`\nFound emails:`);
  [...results.high, ...results.medium].forEach(r => {
    console.log(`  [${r.confidence}] ${r.name} → ${r.email} (${r.source})`);
  });
}

if (results.notFound.length > 0) {
  console.log(`\nNot found:`);
  results.notFound.forEach(b => console.log(`  ${b.name} — ${b.category}, ${b.location}`));
}
