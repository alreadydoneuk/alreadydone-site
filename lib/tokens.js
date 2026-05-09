import { supabase } from './db.js';
import 'dotenv/config';

const INPUT_COST_PER_M = 3;
const OUTPUT_COST_PER_M = 15;

export function calcCost(inputTokens, outputTokens) {
  return (inputTokens / 1_000_000) * INPUT_COST_PER_M + (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;
}

export async function logTokens(agent, model, inputTokens, outputTokens) {
  const cost = calcCost(inputTokens, outputTokens);
  const { error } = await supabase
    .from('token_usage')
    .insert({ agent, model, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost });
  if (error) console.error('Failed to log token usage:', error.message);
  return cost;
}

export async function getDailyUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('token_usage')
    .select('agent, input_tokens, output_tokens, cost_usd, created_at')
    .gte('created_at', `${today}T00:00:00Z`);
  if (error) throw error;
  return data || [];
}

export async function getWeeklyUsage() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('token_usage')
    .select('agent, input_tokens, output_tokens, cost_usd, created_at')
    .gte('created_at', weekAgo);
  if (error) throw error;
  return data || [];
}

export async function getUsageSummary() {
  const [daily, weekly] = await Promise.all([getDailyUsage(), getWeeklyUsage()]);

  const sumRows = rows => rows.reduce(
    (acc, r) => ({
      input: acc.input + r.input_tokens,
      output: acc.output + r.output_tokens,
      cost: acc.cost + parseFloat(r.cost_usd),
    }),
    { input: 0, output: 0, cost: 0 }
  );

  const d = sumRows(daily);
  const w = sumRows(weekly);

  // Anthropic free tier / usage tier thresholds — update if account tier changes
  // These are rough guides: Claude API usage limits vary by tier and are not publicly fixed
  const DAILY_TOKEN_GUIDE = 1_000_000;
  const WEEKLY_COST_GUIDE = 10.00;

  const dailyTokensUsed = d.input + d.output;
  const dailyPct = Math.round((dailyTokensUsed / DAILY_TOKEN_GUIDE) * 100);
  const weeklySpend = w.cost;

  // Hourly burn rate based on today's usage so far
  const hourOfDay = new Date().getUTCHours();
  const hoursElapsed = Math.max(hourOfDay, 1);
  const burnPerHour = d.cost / hoursElapsed;

  // Agent breakdown for today
  const agentMap = {};
  for (const r of daily) {
    if (!agentMap[r.agent]) agentMap[r.agent] = { input: 0, output: 0, cost: 0 };
    agentMap[r.agent].input += r.input_tokens;
    agentMap[r.agent].output += r.output_tokens;
    agentMap[r.agent].cost += parseFloat(r.cost_usd);
  }

  return {
    daily: { ...d, tokens: dailyTokensUsed, pct: dailyPct },
    weekly: { ...w },
    burnPerHour,
    weeklySpend,
    weeklyBudgetRemaining: Math.max(0, WEEKLY_COST_GUIDE - weeklySpend),
    agentBreakdown: agentMap,
  };
}
