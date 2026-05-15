import { supabase } from '../lib/db.js';
import { agentCall } from '../lib/claude.js';
import { eaBriefing, eaAlert } from '../lib/slack.js';
import { getUndeliveredReports, markReportsDelivered, getRecentReports } from '../lib/reports.js';
import 'dotenv/config';

// EA morning briefing — runs at 8am
export async function runEaMorningBriefing() {
  console.log('\n[EA Agent] Morning briefing...');
  await runEaBriefing('morning');
}

// EA evening briefing — runs at 5pm
export async function runEaEveningBriefing() {
  console.log('\n[EA Agent] Evening briefing...');
  await runEaBriefing('evening');
}

// EA monitor — event-driven, polls for new undelivered reports
// Returns true if it fired Claude, false if nothing to do
export async function runEaMonitor() {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const undelivered = await getUndeliveredReports(fiveMinAgo);

  if (undelivered.length === 0) {
    return false;
  }

  console.log(`\n[EA Monitor] ${undelivered.length} new report(s) — routing...`);

  const summaries = undelivered
    .map(r => `[${r.agent}] ${r.report_text.slice(0, 300)}...`)
    .join('\n\n');

  const alert = await agentCall(
    'ea-monitor',
    `You are the Executive Assistant for Already Done. New automated reports have arrived.
Write a brief 2–3 sentence summary of what just came in and flag anything requiring immediate attention from Dean.
Keep it under 100 words. Format for Slack.`,
    `New reports just published:\n\n${summaries}`
  );

  await eaAlert('New reports available', alert);
  await markReportsDelivered(undelivered.map(r => r.id));
  return true;
}

async function runEaBriefing(session) {
  const now = new Date();

  // Pull recent pipeline snapshot
  const [{ data: pipelineSnap }, { data: recentActivity }] = await Promise.all([
    supabase.from('businesses').select('pipeline_status').in('pipeline_status', ['researched', 'template_built', 'emailed', 'replied_positive', 'paid', 'delivered']),
    supabase.from('interactions').select('type, direction, content_summary').gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).limit(20),
  ]);

  const statusCounts = {};
  for (const b of (pipelineSnap || [])) {
    statusCounts[b.pipeline_status] = (statusCounts[b.pipeline_status] || 0) + 1;
  }

  const activityList = (recentActivity || [])
    .filter(i => i.content_summary)
    .slice(0, 10)
    .map(i => `- [${i.direction}/${i.type}] ${i.content_summary}`)
    .join('\n');

  const pipelineContext = `
Pipeline snapshot (${now.toDateString()}):
${Object.entries(statusCounts).map(([s, c]) => `- ${s}: ${c}`).join('\n') || '(no data)'}

Recent 24h activity:
${activityList || '(none)'}
`;

  const systemPrompt = `You are Dean Rougvie's Executive Assistant at Already Done, a one-person UK web design business.
You produce ${session === 'morning' ? 'morning' : 'evening'} briefings delivered to Slack.
${session === 'morning' ? 'Morning briefing: focus on what needs attention today, pipeline status, and any anomalies overnight.' : 'Evening briefing: focus on what happened today, wins, outstanding items, and preparation for tomorrow.'}
Keep under 400 words. Warm but efficient tone. Format for Slack with *bold* for key actions.`;

  const userPrompt = `Produce the ${session === 'morning' ? '🌅 morning' : '🌆 evening'} briefing for ${now.toDateString()}.

${pipelineContext}

Structure:
1. At a glance — 3 bullet points on the most important things right now
2. Pipeline health — brief status of active deals and pipeline movement
3. ${session === 'morning' ? 'Today\'s priorities — top 3 actions for Dean to take today' : 'Today\'s wrap — what moved, what didn\'t, one thing to prep for tomorrow'}`;

  const briefing = await agentCall('ea-agent', systemPrompt, userPrompt, 1500);
  await eaBriefing(briefing);
  console.log(`[EA Agent] ${session} briefing delivered.`);
  return { briefing };
}
