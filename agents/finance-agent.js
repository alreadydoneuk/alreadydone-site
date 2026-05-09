import { supabase } from '../lib/db.js';
import { agentCall } from '../lib/claude.js';
import { agentReport } from '../lib/slack.js';
import { saveReport } from '../lib/reports.js';
import 'dotenv/config';

export async function runFinanceAgent() {
  console.log('\n[Finance Agent] Starting P&L analysis...');

  const now = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Pull financial data
  const { data: recentPayments } = await supabase
    .from('finance')
    .select('*')
    .gte('created_at', weekAgo)
    .order('created_at', { ascending: false });

  const { data: monthPayments } = await supabase
    .from('finance')
    .select('*')
    .gte('created_at', monthAgo);

  const { data: tokenCosts } = await supabase
    .from('token_usage')
    .select('cost_usd, created_at')
    .gte('created_at', monthAgo);

  const { data: pipelineStats } = await supabase
    .from('businesses')
    .select('pipeline_status')
    .in('pipeline_status', ['emailed', 'paid', 'delivered', 'template_built']);

  const weekRevenue = (recentPayments || []).reduce((s, r) => s + parseFloat(r.amount_gbp || 0), 0);
  const monthRevenue = (monthPayments || []).reduce((s, r) => s + parseFloat(r.amount_gbp || 0), 0);
  const monthApiCost = (tokenCosts || []).reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0);

  const statusCounts = {};
  for (const b of (pipelineStats || [])) {
    statusCounts[b.pipeline_status] = (statusCounts[b.pipeline_status] || 0) + 1;
  }

  const dataContext = `
Financial data for Already Done (week ending ${now.toDateString()}):

Revenue this week: £${weekRevenue.toFixed(2)} from ${(recentPayments || []).length} payment(s)
Revenue this month: £${monthRevenue.toFixed(2)} from ${(monthPayments || []).length} payment(s)
API costs this month: $${monthApiCost.toFixed(4)} USD

Fixed and variable operating costs (for context):
- Serper.dev (Google Search API): $60.00 purchased 9 May 2026 (Receipt #80053351-164019517, via Paddle/PayPal). 50,000 credits included. ~3 Serper searches per business enriched = ~$0.003/business. At current enrichment rate of ~150/day, ~$0.45/day. 50k credits lasts ~4–5 months at that rate.
- Google Places API: cost per research lookup (Places Details).
- ForwardEmail Enhanced plan: $3.00/month (unlimited domains, IMAP). Unlimited prospect email provisioning.
- Anthropic Claude API: per-token, tracked in token_usage table above.
- Porkbun domain registrations: ~£5–10/domain at cost. Orders to date: #10284666, #10284713.

Pipeline:
- Emailed (awaiting reply): ${statusCounts.emailed || 0}
- Paid (awaiting delivery): ${statusCounts.paid || 0}
- Delivered: ${statusCounts.delivered || 0}
- Template built (ready to email): ${statusCounts.template_built || 0}

Report add-on (£5/month recurring):
- Paid report subscribers: ${(await supabase.from('businesses').select('id', { count: 'exact', head: true }).eq('order_include_report', true).eq('pipeline_status', 'delivered')).count || 0}
- Free trial reports sent: ${(await supabase.from('report_history').select('id', { count: 'exact', head: true }).eq('report_type', 'free_trial')).count || 0}
- Report MRR (£5 x subscribers): £${((await supabase.from('businesses').select('id', { count: 'exact', head: true }).eq('order_include_report', true).eq('pipeline_status', 'delivered')).count || 0) * 5}
`;

  const report = await agentCall(
    'finance-agent',
    `You are the Finance Agent for Already Done, a one-person UK web design business selling £99 websites to local SMEs.
Your job is to produce a weekly P&L and cost summary for Dean Rougvie, the founder.
Keep your report under 500 words. Be specific and direct. Flag any anomalies clearly.
Format for Slack: use *bold* for key figures, avoid bullet spam.`,
    `Produce this week's finance report based on the following data:
${dataContext}

Cover: revenue in / pipeline conversion health / API cost efficiency / any concerns.
End with one clear recommendation for next week.`
  );

  await saveReport('finance-agent', report);
  await agentReport('dev', '📊 Finance Report', report);
  console.log('[Finance Agent] Report delivered.');
  return { report };
}
