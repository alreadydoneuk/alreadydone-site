// Launch script — fires site builder then outreach immediately after.
// Posts stage-by-stage updates to Slack. Run once at go-live.
import { runSiteBuilderAgent } from '../agents/site-builder-agent.js';
import { runOutreachAgent } from '../agents/outreach-agent.js';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(__dirname, 'deploy-site.sh');

const CHANNELS = {
  dm:       process.env.SLACK_DM,
  pipeline: process.env.SLACK_PIPELINE,
  leads:    process.env.SLACK_LEADS,
  revenue:  process.env.SLACK_REVENUE,
  ea:       process.env.SLACK_EA,
  ceo:      process.env.SLACK_CEO,
  dev:      process.env.SLACK_DEV,
};

async function post(webhooks, text) {
  const targets = Array.isArray(webhooks) ? webhooks : [webhooks];
  await Promise.all(targets.filter(Boolean).map(url =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {})
  ));
}

const all     = Object.values(CHANNELS);
const ops     = [CHANNELS.dm, CHANNELS.pipeline, CHANNELS.ceo, CHANNELS.ea];
const leadrev = [CHANNELS.dm, CHANNELS.leads, CHANNELS.revenue, CHANNELS.ceo];

// ── LAUNCH ANNOUNCEMENT ──────────────────────────────────────────────────────
await post(all,
`🚀 *ALREADY DONE — GO FOR LAUNCH*

Test mode is off. Real emails going to real prospects from this run forward.

Site builder starting now — 10 preview sites queued.
Outreach fires immediately after.

This is not a drill.`
);

console.log('\n🚀 ALREADY DONE — LAUNCH\n');
console.log('TEST_EMAIL removed. Live emails active.\n');

// ── STAGE 1: SITE BUILDER ────────────────────────────────────────────────────
await post(ops, '🏗️ *Site builder:* Starting — building 10 preview sites...');
console.log('=== Stage 1: Site Builder ===');

let buildResult;
try {
  buildResult = await runSiteBuilderAgent();
  console.log(`Built: ${buildResult.built} sites`);
} catch (err) {
  await post(ops, `🔴 *Site builder crashed:* \`${err.message}\``);
  console.error('Site builder crashed:', err);
  process.exit(1);
}

if (buildResult.built > 0) {
  console.log('\nDeploying preview sites...');
  try {
    execSync(`bash "${DEPLOY_SCRIPT}"`, { stdio: 'inherit' });
    console.log('Preview sites deployed.\n');
  } catch (err) {
    await post(ops, `⚠️ *Deploy failed:* \`${err.message}\``);
  }

  // Preview URLs already posted to #dm by the site builder agent's own alert call.
  // Just notify leads + CEO that outreach is starting.
  await post([CHANNELS.leads, CHANNELS.ceo],
`✅ *${buildResult.built} preview site${buildResult.built !== 1 ? 's' : ''} built and deployed.*
Outreach starting now — real emails going to real prospects.`
  );
} else {
  await post(ops, '⚠️ *Site builder:* No sites built — check pipeline log.');
  console.log('No sites built. Check DB for template_built candidates.');
}

// ── STAGE 2: OUTREACH ────────────────────────────────────────────────────────
await post(ops, '📧 *Outreach:* Starting — sending to real prospects...');
console.log('=== Stage 2: Outreach ===');

let outreachResult;
try {
  outreachResult = await runOutreachAgent({ force: true });
  console.log(`Outreach result:`, outreachResult);
} catch (err) {
  await post(ops, `🔴 *Outreach crashed:* \`${err.message}\``);
  console.error('Outreach crashed:', err);
  process.exit(1);
}

const sent = outreachResult?.sent ?? 0;

if (sent > 0) {
  await post(leadrev,
`📬 *${sent} outreach email${sent !== 1 ? 's' : ''} sent to real prospects.*

Already Done is live. Prospects are receiving emails now.
Reply monitor is watching — any replies will surface in #leads.`
  );
} else {
  await post(ops, `⚠️ *Outreach:* 0 emails sent — no template_built businesses ready yet.`);
}

// ── DONE ─────────────────────────────────────────────────────────────────────
await post([CHANNELS.dm, CHANNELS.ceo],
`✅ *Launch complete.*

Sites built: ${buildResult?.built ?? 0}
Emails sent: ${sent}

Pipeline cron resumes normal schedule from tomorrow. Reply monitor watching.`
);

console.log('\n✅ Launch complete.');
console.log(`  Sites built: ${buildResult?.built ?? 0}`);
console.log(`  Emails sent: ${sent}\n`);
