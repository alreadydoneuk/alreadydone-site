import { supabase } from '../lib/db.js';
import { agentCall } from '../lib/claude.js';
import { agentReport } from '../lib/slack.js';
import { saveReport } from '../lib/reports.js';
import 'dotenv/config';

export async function runSalesManagerAgent() {
  console.log('\n[Sales Manager Agent] Analysing sales activity...');

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: emailed } = await supabase
    .from('businesses')
    .select('name, category, location, lead_temperature, pipeline_status, updated_at')
    .eq('pipeline_status', 'emailed')
    .gte('updated_at', weekAgo);

  const { data: positiveReplies } = await supabase
    .from('businesses')
    .select('name, category, location, lead_temperature')
    .eq('pipeline_status', 'replied_positive')
    .gte('updated_at', weekAgo);

  const { data: paid } = await supabase
    .from('businesses')
    .select('name, category, location')
    .eq('pipeline_status', 'paid')
    .gte('updated_at', weekAgo);

  const { data: delivered } = await supabase
    .from('businesses')
    .select('name, category, location')
    .eq('pipeline_status', 'delivered')
    .gte('updated_at', weekAgo);

  const { data: followUps } = await supabase
    .from('interactions')
    .select('content_summary')
    .eq('type', 'follow_up')
    .gte('created_at', weekAgo);

  const { data: dropped } = await supabase
    .from('businesses')
    .select('drop_reason')
    .eq('pipeline_status', 'dropped')
    .gte('updated_at', weekAgo);

  const dropReasons = {};
  for (const d of (dropped || [])) {
    if (d.drop_reason) dropReasons[d.drop_reason] = (dropReasons[d.drop_reason] || 0) + 1;
  }

  const dataContext = `
Sales activity — past 7 days:
Outreach emails sent: ${(emailed || []).length}
Positive replies: ${(positiveReplies || []).length}
Payments received: ${(paid || []).length}
Sites delivered: ${(delivered || []).length}
Follow-up emails sent: ${(followUps || []).length}
Dropped leads: ${(dropped || []).length}

Drop reasons: ${Object.entries(dropReasons).map(([r, c]) => `${r}(${c})`).join(', ') || 'none'}

Recent positive replies:
${(positiveReplies || []).slice(0, 5).map(b => `- ${b.name}, ${b.category}, ${b.location} [${b.lead_temperature}]`).join('\n') || 'none'}
`;

  const report = await agentCall(
    'sales-manager-agent',
    `You are the Sales Manager Agent for Already Done, a one-person UK web design business selling £99 websites to SMEs.
Analyse weekly sales activity and conversion performance.
Keep under 500 words. Be specific about numbers. Identify what's working and what isn't.
Format for Slack: use *bold* for key numbers.`,
    `Produce this week's sales report:
${dataContext}

Cover: outreach volume / conversion rates through the funnel / follow-up effectiveness / drop analysis.
End with one specific sales action for next week.`
  );

  await saveReport('sales-manager-agent', report);
  await agentReport('dev', '💼 Sales Report', report);
  console.log('[Sales Manager Agent] Report delivered.');
  return { report };
}
