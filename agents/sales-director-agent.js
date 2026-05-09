import { supabase } from '../lib/db.js';
import { agentCall } from '../lib/claude.js';
import { eaBriefing } from '../lib/slack.js';
import { saveReport, getRecentReports } from '../lib/reports.js';
import 'dotenv/config';

export async function runSalesDirectorAgent() {
  console.log('\n[Sales Director Agent] Synthesising weekly reports...');

  // Pull the 5 weekly specialist reports
  const reportTypes = ['finance-agent', 'sales-manager-agent', 'cs-agent', 'bizdev-agent', 'eo-agent'];
  const reports = await getRecentReports(reportTypes, 7);

  const reportBlock = reportTypes
    .map(type => {
      const r = reports[type];
      return r ? `=== ${type.toUpperCase()} ===\n${r}` : `=== ${type.toUpperCase()} ===\n(No report this week)`;
    })
    .join('\n\n');

  // Pull headline metrics
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: paid }, { data: tokenCosts }, { data: pipeline }] = await Promise.all([
    supabase.from('finance').select('amount_gbp').gte('created_at', weekAgo),
    supabase.from('token_usage').select('cost_usd').gte('created_at', weekAgo),
    supabase.from('businesses').select('pipeline_status').in('pipeline_status', ['emailed', 'replied_positive', 'paid', 'delivered']),
  ]);

  const weekRevenue = (paid || []).reduce((s, r) => s + parseFloat(r.amount_gbp || 0), 0);
  const weekApiCost = (tokenCosts || []).reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0);
  const activeDeals = (pipeline || []).filter(b => b.pipeline_status === 'replied_positive').length;

  const dataContext = `
Headline metrics this week:
Revenue: £${weekRevenue.toFixed(2)}
API costs: $${weekApiCost.toFixed(4)} USD
Active deals (positive reply, not yet paid): ${activeDeals}

Specialist reports for synthesis:
${reportBlock}
`;

  const report = await agentCall(
    'sales-director-agent',
    `You are the Sales Director Agent for Already Done, a one-person UK web design business.
Your role is to read all specialist weekly reports and produce a single strategic synthesis for Dean Rougvie.
This is the most important weekly report — it informs Dean's decisions for the coming week.
Keep under 500 words. Be decisive. No waffle. Identify the single most important priority.
Format for Slack: use *bold* for key decisions and numbers.`,
    `Synthesise the following specialist reports into a strategic weekly executive summary:
${dataContext}

Cover: what the business achieved / where it's heading / top risk right now / one clear decision needed from Dean.
End with three prioritised actions for the coming week — ranked by impact.`,
    2000
  );

  await saveReport('sales-director-agent', report);
  await eaBriefing(`*Weekly Strategic Summary*\n\n${report}`);
  console.log('[Sales Director Agent] Report delivered to #rougvie-ceo.');
  return { report };
}
