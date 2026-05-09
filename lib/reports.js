import { supabase } from './db.js';

export async function saveReport(agent, reportText) {
  const wordCount = reportText.trim().split(/\s+/).length;
  const { error } = await supabase
    .from('agent_reports')
    .insert({ agent, report_text: reportText, word_count: wordCount });
  if (error) console.error(`Failed to save report for ${agent}:`, error.message);
}

// Returns most recent report per agent type within the past N days
export async function getRecentReports(agentNames, withinDays = 7) {
  const since = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('agent_reports')
    .select('agent, report_text, created_at')
    .in('agent', agentNames)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (error) throw error;

  // One report per agent — first match wins (most recent)
  const result = {};
  for (const row of (data || [])) {
    if (!result[row.agent]) result[row.agent] = row.report_text;
  }
  return result;
}

export async function getUndeliveredReports(since) {
  const { data, error } = await supabase
    .from('agent_reports')
    .select('id, agent, report_text, created_at')
    .eq('ea_delivered', false)
    .gte('created_at', since)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function markReportsDelivered(ids) {
  if (!ids.length) return;
  const { error } = await supabase
    .from('agent_reports')
    .update({ ea_delivered: true })
    .in('id', ids);
  if (error) console.error('Failed to mark reports delivered:', error.message);
}
