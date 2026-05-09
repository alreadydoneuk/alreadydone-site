import { supabase } from '../lib/db.js';
import { agentCall } from '../lib/claude.js';
import { agentReport } from '../lib/slack.js';
import { saveReport } from '../lib/reports.js';
import 'dotenv/config';

export async function runCustomerServiceAgent() {
  console.log('\n[CS Agent] Analysing comms quality...');

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: interactions } = await supabase
    .from('interactions')
    .select('type, direction, content_summary, metadata, created_at')
    .gte('created_at', weekAgo)
    .order('created_at', { ascending: false })
    .limit(50);

  const { data: replyStats } = await supabase
    .from('businesses')
    .select('pipeline_status, lead_temperature')
    .in('pipeline_status', ['replied_positive', 'replied_negative', 'emailed', 'paid', 'delivered', 'dropped'])
    .gte('updated_at', weekAgo);

  const positives = (replyStats || []).filter(b => b.pipeline_status === 'replied_positive').length;
  const negatives = (replyStats || []).filter(b => b.pipeline_status === 'replied_negative').length;
  const dropped = (replyStats || []).filter(b => b.pipeline_status === 'dropped').length;

  const sentEmails = (interactions || []).filter(i => i.type === 'email' && i.direction === 'outbound').length;
  const repliesReceived = (interactions || []).filter(i => i.type === 'email' && i.direction === 'inbound').length;
  const followUps = (interactions || []).filter(i => i.type === 'follow_up').length;

  const summaryList = (interactions || [])
    .filter(i => i.content_summary)
    .slice(0, 15)
    .map(i => `- [${i.direction}/${i.type}] ${i.content_summary}`)
    .join('\n');

  const dataContext = `
Customer comms report period: past 7 days

Emails sent: ${sentEmails}
Replies received: ${repliesReceived}
Follow-ups sent: ${followUps}
Positive replies: ${positives}
Negative replies: ${negatives}
Dropped (no engagement): ${dropped}
Reply rate: ${sentEmails > 0 ? Math.round((repliesReceived / sentEmails) * 100) : 0}%
Positive rate (of replies): ${repliesReceived > 0 ? Math.round((positives / repliesReceived) * 100) : 0}%

Recent interaction summaries:
${summaryList || 'No interactions this week.'}
`;

  const report = await agentCall(
    'cs-agent',
    `You are the Customer Service Agent for Already Done, a one-person UK web design business selling £99 websites.
Analyse outreach quality, reply handling, and tone based on interaction data.
Keep under 500 words. Be direct and practical — Dean handles all comms personally.
Format for Slack: use *bold* for key metrics.`,
    `Produce this week's customer service and comms quality report:
${dataContext}

Cover: reply rate / sentiment trends / tone quality observations / any interactions that went wrong / follow-up effectiveness.
End with one concrete improvement to make next week.`
  );

  await saveReport('cs-agent', report);
  await agentReport('dev', '💬 Customer Service Report', report);
  console.log('[CS Agent] Report delivered.');
  return { report };
}
