// Deletes all businesses (cascade-deletes interactions) and resets queue to pending.
// Run once before a fresh Edinburgh-outward scan with the expanded category set.
// Usage: node scripts/clean-start.js

import { supabase } from '../lib/db.js';
import 'dotenv/config';

console.log('WARNING: This will delete ALL businesses, interactions and reset the queue.');
console.log('Starting in 5 seconds — Ctrl+C to abort.\n');
await new Promise(r => setTimeout(r, 5000));

// Delete interactions first (FK constraint not set to CASCADE on live DB)
const { error: intError } = await supabase
  .from('interactions')
  .delete()
  .neq('id', '00000000-0000-0000-0000-000000000000');
if (intError) throw intError;
console.log('Interactions deleted');

// Now safe to delete businesses
const { error: bizError } = await supabase
  .from('businesses')
  .delete()
  .neq('id', '00000000-0000-0000-0000-000000000000');
if (bizError) throw bizError;
console.log('Businesses deleted');

// Reset queue — mark all complete/running back to pending
const { error: qError } = await supabase
  .from('queue')
  .update({ status: 'pending', businesses_found: 0, times_run: 0, last_run_at: null })
  .in('status', ['complete', 'running']);
if (qError) throw qError;
console.log('Queue reset to pending');

console.log('\nClean start ready.');
