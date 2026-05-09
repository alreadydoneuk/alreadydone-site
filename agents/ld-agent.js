import { supabase } from '../lib/db.js';
import { agentCall } from '../lib/claude.js';
import { agentReport } from '../lib/slack.js';
import { saveReport } from '../lib/reports.js';
import { execSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = `${__dirname}/..`;

export async function runLdAgent() {
  console.log('\n[LD Agent] Analysing codebase health...');

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Git log for the past week
  let gitLog = '';
  let gitDiff = '';
  try {
    gitLog = execSync(`git -C ${ROOT} log --oneline --since="7 days ago" 2>/dev/null || echo "No git history"`).toString().trim();
    gitDiff = execSync(`git -C ${ROOT} diff --stat HEAD~5 HEAD 2>/dev/null || echo ""`).toString().trim().slice(0, 1000);
  } catch {
    gitLog = 'Git not available or no commits';
  }

  // Agent error rate from interactions
  const { data: errors } = await supabase
    .from('interactions')
    .select('content_summary, created_at')
    .eq('type', 'error')
    .gte('created_at', weekAgo)
    .limit(20);

  // Token usage by agent for efficiency view
  const { data: tokenRows } = await supabase
    .from('token_usage')
    .select('agent, input_tokens, output_tokens, cost_usd')
    .gte('created_at', weekAgo);

  const agentTokens = {};
  for (const r of (tokenRows || [])) {
    if (!agentTokens[r.agent]) agentTokens[r.agent] = { tokens: 0, cost: 0 };
    agentTokens[r.agent].tokens += r.input_tokens + r.output_tokens;
    agentTokens[r.agent].cost += parseFloat(r.cost_usd);
  }

  const agentSummary = Object.entries(agentTokens)
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([a, s]) => `- ${a}: ${s.tokens.toLocaleString()} tokens ($${s.cost.toFixed(4)})`)
    .join('\n');

  const errorList = (errors || [])
    .slice(0, 10)
    .map(e => `- ${e.content_summary}`)
    .join('\n');

  const dataContext = `
Codebase and system health — past 7 days:

Recent commits:
${gitLog || 'No commits this week'}

File changes summary:
${gitDiff || 'N/A'}

Errors logged (interactions table):
${errorList || 'No errors logged'}

Agent token usage this week:
${agentSummary || 'No token data'}
`;

  const report = await agentCall(
    'ld-agent',
    `You are the Lead Developer Agent (LD-01) for Already Done, a one-person UK web design pipeline built in Node.js.
Your role is to audit codebase health, review recent changes, and surface any technical risks or improvements.
Keep under 500 words. Be technical and specific. Dean is the sole developer.
Format for Slack: use *bold* for key points. Use \`code\` formatting for file/function names.`,
    `Produce this week's technical health report and sprint plan:
${dataContext}

Cover: what changed this week / error patterns / agent efficiency / any technical debt spotted.
End with a prioritised sprint suggestion for the coming week (top 3 tasks only).`
  );

  await saveReport('ld-agent', report);
  await agentReport('lead_dev', '🛠️ Lead Dev Report', report);
  console.log('[LD Agent] Report delivered.');
  return { report };
}
