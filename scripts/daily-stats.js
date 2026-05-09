// Outputs a two-part stats summary: today's run + all-time totals.
// Designed to be called by the cron wrapper after each pipeline run.
// Usage: node scripts/daily-stats.js [YYYY-MM-DD]   (defaults to today UTC)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { fetch: globalThis.fetch });

const dateArg = process.argv[2];
const todayUTC = dateArg || new Date().toISOString().slice(0, 10);
const dayStart = `${todayUTC}T00:00:00.000Z`;
const dayEnd   = `${todayUTC}T23:59:59.999Z`;

async function count(table, filters = []) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  for (const [method, ...args] of filters) q = q[method](...args);
  const { count } = await q;
  return count || 0;
}

const T = 'businesses';

const [
  todayTotal,    todayProspects,    todayHot,    todayWarm,    todayCold,
  allTotal,      allProspects,      allHot,      allWarm,      allCold,
] = await Promise.all([
  count(T, [['gte','created_at',dayStart],['lte','created_at',dayEnd]]),
  count(T, [['gte','created_at',dayStart],['lte','created_at',dayEnd],['eq','is_prospect',true]]),
  count(T, [['gte','created_at',dayStart],['lte','created_at',dayEnd],['eq','lead_temperature','hot']]),
  count(T, [['gte','created_at',dayStart],['lte','created_at',dayEnd],['eq','lead_temperature','warm']]),
  count(T, [['gte','created_at',dayStart],['lte','created_at',dayEnd],['eq','lead_temperature','cold']]),
  count(T),
  count(T, [['eq','is_prospect',true]]),
  count(T, [['eq','lead_temperature','hot']]),
  count(T, [['eq','lead_temperature','warm']]),
  count(T, [['eq','lead_temperature','cold']]),
]);

function pct(n, of) { return of === 0 ? '0%' : `${Math.round((n / of) * 100)}%`; }

const lines = [
  `Today (${todayUTC})`,
  `  ${todayTotal} new listings — ${pct(todayProspects, todayTotal)} prospects (${todayProspects})`,
  `  Hot ${todayHot} (${pct(todayHot, todayProspects)})  Warm ${todayWarm} (${pct(todayWarm, todayProspects)})  Cold ${todayCold} (${pct(todayCold, todayProspects)})`,
  ``,
  `All time`,
  `  ${allTotal} listings — ${pct(allProspects, allTotal)} prospects (${allProspects})`,
  `  Hot ${allHot} (${pct(allHot, allProspects)})  Warm ${allWarm} (${pct(allWarm, allProspects)})  Cold ${allCold} (${pct(allCold, allProspects)})`,
];

console.log(lines.join('\n'));
