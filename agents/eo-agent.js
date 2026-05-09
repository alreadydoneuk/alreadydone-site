import { supabase } from '../lib/db.js';
import { agentCall } from '../lib/claude.js';
import { agentReport, envAlert } from '../lib/slack.js';
import { saveReport } from '../lib/reports.js';
import 'dotenv/config';

export async function runEoAgent() {
  console.log('\n[EO Agent] Starting environmental footprint estimate...');

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: tokenRows } = await supabase
    .from('token_usage')
    .select('input_tokens, output_tokens, model, agent')
    .gte('created_at', weekAgo);

  const { data: sitesBuilt } = await supabase
    .from('businesses')
    .select('id')
    .eq('pipeline_status', 'template_built')
    .gte('updated_at', weekAgo);

  const totalInput = (tokenRows || []).reduce((s, r) => s + r.input_tokens, 0);
  const totalOutput = (tokenRows || []).reduce((s, r) => s + r.output_tokens, 0);
  const totalTokens = totalInput + totalOutput;
  const sitesCount = (sitesBuilt || []).length;

  const agentBreakdown = {};
  for (const r of (tokenRows || [])) {
    agentBreakdown[r.agent] = (agentBreakdown[r.agent] || 0) + r.input_tokens + r.output_tokens;
  }

  const dataContext = `
Weekly token consumption (past 7 days):
Total tokens: ${totalTokens.toLocaleString()} (${totalInput.toLocaleString()} input / ${totalOutput.toLocaleString()} output)
Sites generated: ${sitesCount}

Agent breakdown:
${Object.entries(agentBreakdown).map(([a, t]) => `- ${a}: ${t.toLocaleString()} tokens`).join('\n')}

Reference carbon factors:
- Running 1M LLM tokens ≈ 0.2–0.5 kWh electricity (GPU inference, data centre)
- UK grid carbon intensity ≈ 200g CO2/kWh (2024 average)
- Anthropic uses renewable energy commitments — discount factor ~0.5
`;

  const report = await agentCall(
    'eo-agent',
    `You are the Environmental Officer Agent for Already Done, a one-person UK web design business.
Your role is to produce a weekly environmental footprint estimate focused on AI compute usage.
Use the token data and provided carbon reference factors to produce a rough estimate.
Be honest about the uncertainty in these estimates. Keep under 500 words.
Format for Slack: use *bold* for key figures.`,
    `Produce the weekly environmental report using this data:
${dataContext}

Cover: estimated kWh consumed / estimated kg CO2e / comparison to everyday equivalents / any efficiency observations.
Note caveats clearly. End with one practical suggestion to reduce compute if warranted.`
  );

  await saveReport('eo-agent', report);
  await agentReport('env', '🌿 EO Weekly Report', report);
  console.log('[EO Agent] Report delivered.');
  return { report };
}
