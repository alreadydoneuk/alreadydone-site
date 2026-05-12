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
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [
    recentPayments,
    monthPayments,
    tokenCosts,
    pipelineStats,
    placesUsageMonth,
    serperUsageMonth,
    resendCountMonth,
    reportSubscribers,
    freeTrialReports,
  ] = await Promise.all([
    supabase.from('finance').select('*').gte('created_at', weekAgo).order('created_at', { ascending: false }).then(r => r.data),
    supabase.from('finance').select('*').gte('created_at', monthAgo).then(r => r.data),
    supabase.from('token_usage').select('model,input_tokens,output_tokens,cost_usd').gte('created_at', monthStart).then(r => r.data),
    supabase.from('businesses').select('pipeline_status').in('pipeline_status', ['emailed', 'paid', 'delivered', 'template_built']).then(r => r.data),
    supabase.from('api_usage').select('calls,cost_usd').eq('api', 'google_places').gte('created_at', monthStart).then(r => r.data),
    supabase.from('api_usage').select('calls,cost_usd').eq('api', 'serper').gte('created_at', monthStart).then(r => r.data),
    supabase.from('interactions').select('id', { count: 'exact', head: true }).in('type', ['email_sent', 'follow_up_sent']).gte('created_at', monthStart).then(r => r.count),
    supabase.from('businesses').select('id', { count: 'exact', head: true }).eq('order_include_report', true).eq('pipeline_status', 'delivered').then(r => r.count),
    supabase.from('report_history').select('id', { count: 'exact', head: true }).eq('report_type', 'free_trial').then(r => r.count),
  ]);

  // Revenue
  const weekRevenue = (recentPayments || []).reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const monthRevenue = (monthPayments || []).reduce((s, r) => s + parseFloat(r.amount || 0), 0);

  // Pipeline counts
  const statusCounts = {};
  for (const b of (pipelineStats || [])) {
    statusCounts[b.pipeline_status] = (statusCounts[b.pipeline_status] || 0) + 1;
  }

  // Claude costs
  let claudeUsd = 0;
  const claudeByModel = {};
  for (const row of (tokenCosts || [])) {
    const isHaiku = (row.model || '').includes('haiku');
    const inRate  = isHaiku ? 0.80 : 3.00;
    const outRate = isHaiku ? 4.00 : 15.00;
    const cost = (row.input_tokens / 1_000_000) * inRate + (row.output_tokens / 1_000_000) * outRate;
    claudeUsd += cost;
    const key = isHaiku ? 'haiku' : 'sonnet';
    if (!claudeByModel[key]) claudeByModel[key] = { calls: 0, cost: 0 };
    claudeByModel[key].calls++;
    claudeByModel[key].cost += cost;
  }

  // Google Places costs (within $200/month free credit)
  const placesCallsMonth = (placesUsageMonth || []).reduce((s, r) => s + (r.calls || 0), 0);
  const placesCostMonth  = (placesUsageMonth || []).reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0);

  // Serper costs (logged per-run by enrichment agent)
  const serperCallsMonth = (serperUsageMonth || []).reduce((s, r) => s + (r.calls || 0), 0);
  const serperCostMonth  = (serperUsageMonth || []).reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0);

  // Serper live balance
  let serperBalance = null;
  try {
    const res = await fetch('https://google.serper.dev/account', {
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY },
    });
    const data = await res.json();
    serperBalance = data.balance ?? null;
  } catch {}

  // Porkbun: count registered domains
  let porkbunDomains = [];
  try {
    const res = await fetch('https://api.porkbun.com/api/json/v3/domain/listAll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: process.env.PORKBUN_API_KEY,
        secretapikey: process.env.PORKBUN_SECRET_KEY,
      }),
    });
    const data = await res.json();
    porkbunDomains = data.domains || [];
  } catch {}

  // Resend: count emails sent this month from interactions (pipeline-sent only)
  const resendSentMonth = resendCountMonth || 0;

  // Total estimated USD spend this month
  const USD_TO_GBP = 0.79;
  const forwardEmailMonthlyUsd = 3.00 / 0.79; // ~$3.80 (£3/month Enhanced plan)
  const totalApiUsd = claudeUsd + serperCostMonth + Math.max(0, placesCostMonth - 200); // Places covered by credit
  const totalApiGbp = totalApiUsd * USD_TO_GBP;

  const dataContext = `
Financial data for Already Done (week ending ${now.toDateString()}):

REVENUE
Revenue this week: £${weekRevenue.toFixed(2)} from ${(recentPayments || []).length} payment(s)
Revenue this month: £${monthRevenue.toFixed(2)} from ${(monthPayments || []).length} payment(s)
Report add-on subscribers (£5/month MRR): ${reportSubscribers || 0} → £${((reportSubscribers || 0) * 5).toFixed(2)}/month
Free trial reports sent: ${freeTrialReports || 0}

PIPELINE
- Template built (ready to email): ${statusCounts.template_built || 0}
- Emailed (awaiting reply): ${statusCounts.emailed || 0}
- Paid (awaiting delivery): ${statusCounts.paid || 0}
- Delivered: ${statusCounts.delivered || 0}

API COSTS (month to date — calendar month)
Anthropic Claude (Sonnet): ${claudeByModel.sonnet?.calls || 0} calls → $${(claudeByModel.sonnet?.cost || 0).toFixed(4)}
Anthropic Claude (Haiku): ${claudeByModel.haiku?.calls || 0} calls → $${(claudeByModel.haiku?.cost || 0).toFixed(4)}
Google Places API: ${placesCallsMonth} calls → $${placesCostMonth.toFixed(2)} (covered by $200/month free credit; net cost $0)
Serper.dev: ${serperCallsMonth} searches logged → $${serperCostMonth.toFixed(4)} estimated; live balance: ${serperBalance !== null ? `${serperBalance.toLocaleString()} credits (~$${(serperBalance / 1000).toFixed(2)} remaining)` : 'unavailable'}
Resend email: ${resendSentMonth} emails sent this month (free up to 3,000/month)
ForwardEmail Enhanced plan: fixed £3.00/month
Porkbun domains registered: ${porkbunDomains.length} domain(s)${porkbunDomains.length ? ': ' + porkbunDomains.map(d => `${d.domain} (exp ${d.expireDate?.split(' ')[0]})`).join(', ') : ''}

Total billable API spend (excl. free tiers): ~$${totalApiUsd.toFixed(2)} / ~£${totalApiGbp.toFixed(2)} this month
Overhead target: 10% of revenue

FIXED COSTS REMINDER
- Serper.dev: 50,000 credits purchased for $60 on 9 May 2026. ~3 searches per enriched business.
- ForwardEmail Enhanced: £3/month unlimited domains.
- Porkbun: ~£10/domain at cost — only registered for paying customers.
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
If overhead_pct > 10% of revenue, flag it and state what revenue is needed to hit the 10% target.
End with one clear recommendation for next week.`
  );

  await saveReport('finance-agent', report);
  await agentReport('dev', '📊 Finance Report', report);
  console.log('[Finance Agent] Report delivered.');
  return { report };
}
