import { execSync } from 'child_process';
import { supabase } from '../lib/db.js';
import { agentCall } from '../lib/claude.js';
import { agentReport } from '../lib/slack.js';
import { saveReport, getRecentReports } from '../lib/reports.js';
import {
  readPageTodos,
  checkTodoBlock,
  appendSessionNote,
  appendTasks,
} from '../lib/notion.js';
import 'dotenv/config';

// Page IDs
const NOTES_LOG_ID   = '3569baa1-3b7d-8191-8274-ed8146e7bfc6';
const TASKS_PAGE_ID  = '3569baa1-3b7d-8133-be08-ec1e04aaac36';

function gitLog(repoPath) {
  try {
    return execSync(
      `git -C "${repoPath}" log --since="midnight" --oneline --no-merges 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim() || '(no commits today)';
  } catch {
    return '(git unavailable)';
  }
}

export async function runChroniclerAgent() {
  console.log('\n[Chronicler] Gathering context...');

  const today = new Date();
  const dateLabel = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // ── 1. Git activity ──────────────────────────────────────────────────────────
  const adCommits  = gitLog('/home/brantley/alreadydone');
  const nbCommits  = gitLog('/home/brantley/NewBiz');

  // ── 2. Pipeline snapshot ─────────────────────────────────────────────────────
  const { data: pipelineSnap } = await supabase
    .from('businesses')
    .select('pipeline_status')
    .in('pipeline_status', ['researched','template_built','emailed','follow_up_sent','replied_positive','payment_pending','paid','delivered','dropped']);

  const statusCounts = {};
  for (const b of (pipelineSnap || [])) {
    statusCounts[b.pipeline_status] = (statusCounts[b.pipeline_status] || 0) + 1;
  }
  const pipelineSummary = Object.entries(statusCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `- ${s}: ${c}`)
    .join('\n');

  // NewBiz pipeline
  const { data: nbSnap } = await supabase
    .from('new_registrations')
    .select('has_website, is_prospect, intro_email_sent_at, email')
    .limit(2000);

  const nbStats = {
    total: nbSnap?.length ?? 0,
    withSite: nbSnap?.filter(r => r.has_website).length ?? 0,
    prospects: nbSnap?.filter(r => r.is_prospect).length ?? 0,
    withEmail: nbSnap?.filter(r => r.email).length ?? 0,
    introSent: nbSnap?.filter(r => r.intro_email_sent_at).length ?? 0,
  };

  // ── 3. Today's agent reports ──────────────────────────────────────────────────
  const reportTypes = ['sales-manager-agent', 'finance-agent', 'meeting-dev', 'meeting-sales-manager', 'meeting-sales-director', 'meeting-ea'];
  const reports = await getRecentReports(reportTypes, 1);
  const recentReportsText = reportTypes
    .filter(t => reports[t])
    .map(t => `=== ${t} ===\n${reports[t].slice(0, 400)}`)
    .join('\n\n') || '(no reports today)';

  // ── 4. Open tasks from Notion ─────────────────────────────────────────────────
  console.log('[Chronicler] Reading Notion tasks...');
  const allTodos = await readPageTodos(TASKS_PAGE_ID);
  const openTodos = allTodos.filter(t => !t.checked);

  const todoContext = openTodos
    .map(t => `[${t.id}] (${t.section || 'general'}) ${t.text}`)
    .join('\n');

  // ── 5. Ask Claude to reconcile ────────────────────────────────────────────────
  console.log('[Chronicler] Asking Claude to reconcile...');

  const rawResponse = await agentCall(
    'chronicler',
    `You are the chronicler for Already Done, a one-person UK web design business.
Your job is to review what happened today, reconcile it against the open task list, and produce a clean daily session note.
You must respond with ONLY valid JSON — no explanation, no markdown wrapper.`,
    `Today is ${dateLabel}.

GIT COMMITS — AlreadyDone (today):
${adCommits}

GIT COMMITS — NewBiz (today):
${nbCommits}

ALREADYDONE PIPELINE:
${pipelineSummary}

NEWBIZ PIPELINE:
- Total registrations: ${nbStats.total}
- With website: ${nbStats.withSite}
- Prospects (no website): ${nbStats.prospects}
- Emails found: ${nbStats.withEmail}
- Intro emails sent: ${nbStats.introSent}

TODAY'S AGENT REPORTS (summaries):
${recentReportsText}

OPEN TASKS IN NOTION (ID | section | text):
${todoContext}

Based on the git commits and agent reports, identify:
1. Which open task IDs were completed today (exact match between commit/report and task text)
2. A clean session note for the Notes Log
3. Any NEW tasks surfaced by today's work that aren't already in the list
4. A short Slack summary

Return ONLY this JSON (no markdown fences):
{
  "blockIdsToCheck": ["uuid-of-completed-task", ...],
  "sessionNoteMarkdown": "### What happened\\n...\\n### Still open\\n...\\n### NewBiz\\n...",
  "newTasks": ["short task description", ...],
  "slackSummary": "one paragraph plain-text summary of the day for Slack"
}

Rules:
- Only check off a task if a commit or report clearly shows it is DONE — do not guess
- sessionNoteMarkdown should be concise, factual, and under 400 words
- newTasks should only be things not already in the open task list above
- Keep slackSummary under 100 words`,
    2500,
  );

  // ── 6. Parse and apply ────────────────────────────────────────────────────────
  let result;
  try {
    // Strip any accidental markdown fences before parsing
    const clean = rawResponse.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    result = JSON.parse(clean);
  } catch (err) {
    console.warn('[Chronicler] JSON parse failed, falling back to plain note:', err.message);
    result = {
      blockIdsToCheck: [],
      sessionNoteMarkdown: rawResponse.slice(0, 2000),
      newTasks: [],
      slackSummary: 'Chronicler ran but could not parse structured output — check Notes Log.',
    };
  }

  // Check off completed tasks
  let checked = 0;
  for (const id of (result.blockIdsToCheck || [])) {
    try {
      await checkTodoBlock(id);
      const task = allTodos.find(t => t.id === id);
      console.log(`  ✓ Checked off: ${task?.text || id}`);
      checked++;
    } catch (err) {
      console.warn(`  ✗ Could not check off ${id}: ${err.message}`);
    }
  }

  // Append session note
  await appendSessionNote(NOTES_LOG_ID, dateLabel, result.sessionNoteMarkdown || '(no notes generated)');
  console.log('[Chronicler] Session note appended to Notes Log.');

  // Append any new tasks
  if (result.newTasks?.length) {
    await appendTasks(TASKS_PAGE_ID, result.newTasks);
    console.log(`[Chronicler] Added ${result.newTasks.length} new task(s).`);
  }

  // Post Slack summary
  const slackMsg = [
    `*📓 Daily Chronicle — ${dateLabel}*`,
    '',
    result.slackSummary || '(no summary)',
    '',
    `Tasks checked off: ${checked} | New tasks added: ${result.newTasks?.length ?? 0}`,
    `AlreadyDone pipeline — emailed: ${statusCounts.emailed ?? 0} | paid: ${statusCounts.paid ?? 0}`,
    `NewBiz — ${nbStats.total} registered | ${nbStats.prospects} prospects | ${nbStats.withEmail} with email`,
  ].join('\n');

  await saveReport('chronicler', slackMsg);
  await agentReport('ea', '📓 Daily Chronicle', slackMsg);

  console.log('[Chronicler] Done.');
  return { checked, newTasks: result.newTasks?.length ?? 0 };
}
