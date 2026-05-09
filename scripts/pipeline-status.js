// Pipeline status dashboard — shows current state at a glance
// Usage: node scripts/pipeline-status.js

import { supabase } from '../lib/db.js';
import 'dotenv/config';

const count = async (filters = {}) => {
  let q = supabase.from('businesses').select('*', { count: 'exact', head: true });
  for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
  const { count: n } = await q;
  return n || 0;
};

const bar = (n, total, width = 20) => {
  const filled = total ? Math.round((n / total) * width) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

console.log('\n══════════════════════════════════════');
console.log('  Already Done — Pipeline Status');
console.log('══════════════════════════════════════\n');

// ── Research ─────────────────────────────────────────────────────────────────
const { count: qTotal }   = await supabase.from('queue').select('*', { count: 'exact', head: true });
const { count: qComplete } = await supabase.from('queue').select('*', { count: 'exact', head: true }).eq('status', 'complete');
const qPct = qTotal ? Math.round((qComplete / qTotal) * 100) : 0;

console.log('Research queue');
console.log(`  ${bar(qComplete, qTotal)} ${qPct}% (${qComplete?.toLocaleString()}/${qTotal?.toLocaleString()} areas scanned)\n`);

// ── Prospects ─────────────────────────────────────────────────────────────────
const total     = await count();
const prospects = await count({ is_prospect: true });
const hot       = await count({ lead_temperature: 'hot' });
const warm      = await count({ lead_temperature: 'warm' });
const cold      = await count({ lead_temperature: 'cold' });

console.log('Businesses found');
console.log(`  Total:     ${total.toLocaleString()}`);
console.log(`  Prospects: ${prospects.toLocaleString()} (${total ? Math.round(prospects/total*100) : 0}%)`);
console.log(`    🔥 Hot:  ${hot}`);
console.log(`    🌤 Warm: ${warm}`);
console.log(`    🧊 Cold: ${cold}\n`);

// ── Pipeline stages ───────────────────────────────────────────────────────────
const stages = [
  ['researched',       'Researched (awaiting site build)'],
  ['template_built',   'Site built (awaiting outreach)'],
  ['emailed',          'Emailed (awaiting reply)'],
  ['follow_up_sent',   'Follow-up sent'],
  ['replied_positive', '✅ Replied — positive'],
  ['replied_negative', '❌ Replied — negative'],
  ['replied_neutral',  '↔️  Replied — neutral'],
  ['paid',             '💰 Paid'],
  ['delivered',        '🚀 Delivered'],
  ['dropped',          'Dropped'],
];

console.log('Pipeline stages');
for (const [status, label] of stages) {
  const n = await count({ pipeline_status: status });
  if (n > 0) console.log(`  ${label.padEnd(34)} ${n}`);
}

// ── Recent activity ───────────────────────────────────────────────────────────
const { data: recent } = await supabase
  .from('interactions')
  .select('type, content_summary, created_at')
  .order('created_at', { ascending: false })
  .limit(5);

if (recent?.length) {
  console.log('\nRecent activity');
  for (const r of recent) {
    const time = new Date(r.created_at).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    console.log(`  ${time}  ${r.type.padEnd(16)} ${r.content_summary?.slice(0, 60) || ''}`);
  }
}

console.log('\n══════════════════════════════════════\n');
