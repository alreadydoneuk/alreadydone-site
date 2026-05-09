import { supabase } from '../lib/db.js';
import { agentCall } from '../lib/claude.js';
import { agentReport } from '../lib/slack.js';
import { saveReport } from '../lib/reports.js';
import 'dotenv/config';

export async function runBusinessDevAgent() {
  console.log('\n[BizDev Agent] Analysing pipeline health...');

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: allBusinesses } = await supabase
    .from('businesses')
    .select('pipeline_status, lead_temperature, category, location, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(500);

  const { data: recentResearched } = await supabase
    .from('businesses')
    .select('category, location, lead_temperature')
    .eq('pipeline_status', 'researched')
    .gte('created_at', weekAgo);

  // Enrichment pipeline — no-website businesses found via directory search
  const { data: phoneRouteLeads } = await supabase
    .from('businesses')
    .select('id')
    .eq('outreach_route', 'phone');

  const { data: enrichedLeads } = await supabase
    .from('businesses')
    .select('id')
    .eq('outreach_route', 'email')
    .eq('website_status', 'none');

  const { data: unenrichedLeads } = await supabase
    .from('businesses')
    .select('id')
    .eq('website_status', 'none')
    .is('email_confidence', null);

  const now = new Date();
  const pipeline = allBusinesses || [];

  const statusCounts = {};
  for (const b of pipeline) {
    statusCounts[b.pipeline_status] = (statusCounts[b.pipeline_status] || 0) + 1;
  }

  const categoryBreakdown = {};
  for (const b of (recentResearched || [])) {
    categoryBreakdown[b.category] = (categoryBreakdown[b.category] || 0) + 1;
  }
  const topCategories = Object.entries(categoryBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, count]) => `${cat}: ${count}`)
    .join(', ');

  const totalProspects = pipeline.filter(b => b.lead_temperature === 'hot' || b.lead_temperature === 'warm').length;
  const hotLeads = pipeline.filter(b => b.lead_temperature === 'hot').length;

  const dataContext = `
Pipeline snapshot (as of ${now.toDateString()}):
Total businesses tracked: ${pipeline.length}
Hot leads: ${hotLeads}
Total prospects (hot + warm): ${totalProspects}

Pipeline stage breakdown:
${Object.entries(statusCounts).map(([s, c]) => `- ${s}: ${c}`).join('\n')}

No-website enrichment pipeline (highest-value group — no site = easy sale):
- Awaiting directory search: ${(unenrichedLeads || []).length}
- Email found via directory: ${(enrichedLeads || []).length} (flowing into main pipeline)
- Phone-only (no email found): ${(phoneRouteLeads || []).length} (flagged for manual outreach)

New leads researched this week: ${(recentResearched || []).length}
Top categories this week: ${topCategories || 'N/A'}
`;

  const report = await agentCall(
    'bizdev-agent',
    `You are the Business Development Agent for Already Done, a one-person UK web design business.
Your job is to analyse pipeline health and identify growth opportunities or bottlenecks.
Keep under 500 words. Be strategic and direct — Dean is the sole decision maker.
Format for Slack: use *bold* for key metrics.`,
    `Produce this week's pipeline and business development report:
${dataContext}

Cover: pipeline velocity / conversion funnel / where leads are getting stuck / category/location opportunities.
End with two specific actions for next week to improve pipeline throughput.`
  );

  await saveReport('bizdev-agent', report);
  await agentReport('dev', '📈 Business Dev Report', report);
  console.log('[BizDev Agent] Report delivered.');
  return { report };
}
