// Verifies database schema and state before running the pipeline.
// Usage: node scripts/verify-db.js

import { supabase } from '../lib/db.js';
import 'dotenv/config';

let pass = 0, fail = 0;
const ok  = msg => { console.log(`  ✓ ${msg}`); pass++; };
const bad = msg => { console.log(`  ✗ ${msg}`); fail++; };

// ── Column presence — check each new migration column individually ───────────
console.log('\nbusinesses table — migration columns');

const newColumns = [
  'is_prospect', 'lead_temperature', 'short_address', 'postcode', 'town',
  'latitude', 'longitude', 'google_maps_uri', 'business_status', 'google_types',
  'primary_type', 'primary_type_label', 'editorial_summary', 'opening_hours',
  'photo_references', 'attributes', 'phone_international', 'last_verified_at',
  'source_category',
];

for (const col of newColumns) {
  const { error } = await supabase.from('businesses').select(col).limit(0);
  if (error?.code === '42703') bad(`Missing column: ${col} — run migrate-directory.sql`);
  else if (error)              bad(`Error checking ${col}: ${error.message}`);
  else                         ok(col);
}

// ── Queue state ──────────────────────────────────────────────────────────────
console.log('\nqueue table');

const { count: total }    = await supabase.from('queue').select('*', { count: 'exact', head: true });
const { count: pending }  = await supabase.from('queue').select('*', { count: 'exact', head: true }).eq('status', 'pending');
const { count: complete } = await supabase.from('queue').select('*', { count: 'exact', head: true }).eq('status', 'complete');

if (total > 0)   ok(`${total} total queue items`);
else             bad('Queue is empty — run: node scripts/seed-queue.js');
if (pending > 0) ok(`${pending} pending, ${complete} complete`);
else             bad('No pending items — run: node scripts/seed-queue.js');

// ── Business counts ──────────────────────────────────────────────────────────
console.log('\nbusinesses table — row counts');

const { count: bizTotal }   = await supabase.from('businesses').select('*', { count: 'exact', head: true });
const { count: bizProspect} = await supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('is_prospect', true);
const { count: hot }        = await supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('lead_temperature', 'hot');
const { count: warm }       = await supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('lead_temperature', 'warm');
const { count: cold }       = await supabase.from('businesses').select('*', { count: 'exact', head: true }).eq('lead_temperature', 'cold');

ok(`Total businesses: ${bizTotal || 0}`);
ok(`Prospects: ${bizProspect || 0}  (hot: ${hot || 0}, warm: ${warm || 0}, cold: ${cold || 0})`);

// ── Interactions ─────────────────────────────────────────────────────────────
console.log('\ninteractions table');

const { count: intTotal } = await supabase.from('interactions').select('*', { count: 'exact', head: true });
ok(`Total interactions: ${intTotal || 0}`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
if (fail === 0) console.log(`All ${pass} checks passed — ready to run.\n`);
else            console.log(`${fail} check(s) failed — fix before running pipeline.\n`);
