import 'dotenv/config';

const WEBHOOKS = {
  pipeline:   process.env.SLACK_PIPELINE,
  leads:      process.env.SLACK_LEADS,
  revenue:    process.env.SLACK_REVENUE,
  dm:         process.env.SLACK_DM,
  notion:     process.env.SLACK_NOTION,
  ea:         process.env.SLACK_EA,
  ceo:        process.env.SLACK_CEO,
  lead_dev:   process.env.SLACK_LEAD_DEV,
  dev:        process.env.SLACK_DEV,
  env:        process.env.SLACK_ENV,
};

async function post(channel, payload) {
  const url = WEBHOOKS[channel];
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`Slack post to #${channel} failed:`, err.message);
  }
}

// ── Public helpers ────────────────────────────────────────────────────────────

export async function pipelineStarted({ time, date }) {
  await post('pipeline', {
    text: `*Already Done pipeline started*`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `🚀 *Pipeline started* — ${date} at ${time}` } },
    ],
  });
}

export async function pipelineFinished({ timeStart, timeEnd, rounds, apiCalls, dailyLimit, stopReason, stats }) {
  await post('pipeline', {
    text: `Pipeline run complete`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *Pipeline complete* — ${timeStart}–${timeEnd}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Rounds:*\n${rounds}` },
          { type: 'mrkdwn', text: `*API calls:*\n${apiCalls}/${dailyLimit}` },
          { type: 'mrkdwn', text: `*Stop reason:*\n${stopReason}` },
        ],
      },
      ...(stats ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `📊 *Today's stats*\n${stats}` },
      }] : []),
    ],
  });
}

export async function siteBuilt({ name, category, location, previewUrl, cost }) {
  await post('pipeline', {
    text: `Site built: ${name}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🏗️ *Site built* — <${previewUrl}|${name}>\n${category} · ${location} · ~$${cost} API cost`,
        },
      },
    ],
  });
}

export async function positiveReply({ name, category, location, email, summary, previewUrl, checkoutUrl }) {
  const actions = [];
  if (previewUrl) {
    actions.push({ type: 'button', text: { type: 'plain_text', text: 'View their site →' }, url: previewUrl });
  }
  if (checkoutUrl) {
    actions.push({ type: 'button', text: { type: 'plain_text', text: 'Checkout link →' }, url: checkoutUrl, style: 'primary' });
  }

  await post('leads', {
    text: `💰 Positive reply from ${name}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '💰 Positive Reply — auto-reply sent' },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${name}*\n${category} · ${location}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*From:*\n${email}` },
          { type: 'mrkdwn', text: `*Summary:*\n"${summary}"` },
        ],
      },
      ...(actions.length ? [{ type: 'actions', elements: actions }] : []),
    ],
  });
}

export async function negativeReply({ name, category, location, email, summary, dropReason }) {
  const reason = dropReason ? ` (${dropReason.replace(/_/g, ' ')})` : '';
  await post('leads', {
    text: `❌ Negative reply from ${name}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `❌ *Negative reply${reason}* — ${name} (${category}, ${location})\n"${summary}"\nFrom: ${email}`,
        },
      },
    ],
  });
}

export async function dailyStats({ date, newListings, newProspects, prospectPct, hot, warm, cold, allTimeListings, allTimeProspects }) {
  await post('pipeline', {
    text: `Daily stats — ${date}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📊 Daily Stats — ${date}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Today — new listings:*\n${newListings.toLocaleString()}` },
          { type: 'mrkdwn', text: `*Today — prospects:*\n${newProspects} (${prospectPct}%)` },
          { type: 'mrkdwn', text: `*Hot / Warm / Cold:*\n${hot} / ${warm} / ${cold}` },
          { type: 'mrkdwn', text: `*All time:*\n${allTimeListings.toLocaleString()} listings · ${allTimeProspects} prospects` },
        ],
      },
    ],
  });
}

export async function notionUpdate({ page, summary, changes }) {
  await post('notion', {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `📝 Notion update — ${page}` } },
      { type: 'section', text: { type: 'mrkdwn', text: summary } },
      ...(changes?.length ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: changes.map(c => `• ${c}`).join('\n') },
      }] : []),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_Pending Notion connection — stored in SYSTEM-REPORT.md and HOW-TO.md_` }],
      },
    ],
  });
}

export async function dm(message) {
  await post('dm', { text: message });
}

export async function alert(title, detail) {
  await post('dm', {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `⚠️ ${title}` } },
      { type: 'section', text: { type: 'mrkdwn', text: detail } },
    ],
  });
}

export async function paymentReceived({ name, category, location, amount }) {
  await post('revenue', {
    text: `💸 Payment received — ${name}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '💸 Payment Received' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${name}*\n${category} · ${location}\n\n*Amount:* £${amount}`,
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `_Deliver the site and update pipeline to delivered_` },
      },
    ],
  });
}

// ── Agent report channels ─────────────────────────────────────────────────────

export async function agentReport(channel, agentName, report) {
  await post(channel, {
    text: `${agentName} report`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: agentName } },
      { type: 'section', text: { type: 'mrkdwn', text: report } },
    ],
  });
}

export async function eaBriefing(briefingText) {
  await post('ceo', {
    text: 'EA Briefing',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '📋 EA Briefing' } },
      { type: 'section', text: { type: 'mrkdwn', text: briefingText } },
    ],
  });
}

export async function eaAlert(title, body) {
  await post('ea', {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `⚡ ${title}` } },
      { type: 'section', text: { type: 'mrkdwn', text: body } },
    ],
  });
}

export async function envAlert(title, detail) {
  await post('env', {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🌿 ${title}` } },
      { type: 'section', text: { type: 'mrkdwn', text: detail } },
    ],
  });
}
