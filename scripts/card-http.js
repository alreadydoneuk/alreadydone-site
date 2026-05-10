#!/usr/bin/env node
/**
 * CardDrop HTTP listener — receives Slack slash commands and triggers provisioning.
 *
 * Slack slash command format:
 *   /card Name | Phone | platform:@handle, platform:@handle | tone | email | price-cap
 *
 * Examples:
 *   /card James Smith | 07700 900123 | instagram:@jsmith, twitter:@jsmith | bright and fun | james@gmail.com
 *   /card Sarah Jones | | linkedin:sarahjones | minimal and professional | sarah@hotmail.com | 10
 *   /card Mike | 07900 111222 | | gothic and dark | mike@icloud.com
 *
 * Parts:  name | phone | socials | tone | recipient-email | price-cap (USD, default 15)
 * All parts after name are optional — omit with empty segment or skip trailing pipes.
 *
 * Setup:
 *   1. Run: node scripts/card-http.js
 *   2. In Slack: Apps → Manage → Build → Create App → Slash Commands
 *      Command: /card
 *      URL: http://<your-tailscale-ip>:3002/card
 *      Short desc: Provision a business card site + email
 *   3. Optional: add SLACK_SIGNING_SECRET to .env for request verification
 */

import { createServer } from 'http';
import { provisionCard } from './provision-card.js';
import 'dotenv/config';

const PORT = process.env.CARD_HTTP_PORT || 3002;

function parseSocials(raw) {
  if (!raw?.trim()) return [];
  return raw.split(',').map(s => {
    const trimmed = s.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) return null;
    const platform = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const handle = trimmed.slice(colonIdx + 1).trim();
    return platform && handle ? { platform, handle } : null;
  }).filter(Boolean);
}

function parseCardCommand(text) {
  const parts = text.split('|').map(p => p.trim());
  const [namePart = '', phonePart = '', socialsPart = '', tonePart = '', emailPart = '', capPart = ''] = parts;

  const name = namePart.trim();
  const phone = phonePart.trim() || null;
  const socials = parseSocials(socialsPart);
  const tone = tonePart.trim() || 'minimal and professional';
  const email = emailPart.trim() || null;
  const priceCap = capPart.trim() ? parseFloat(capPart.trim()) : undefined;

  return { name, phone, socials, tone, email, priceCap };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseFormBody(body) {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CardDrop OK');
    return;
  }

  if (req.method === 'POST' && req.url === '/card') {
    const rawBody = await readBody(req);

    // Accept both Slack slash command (form-encoded) and JSON
    let commandText, userName, userId;
    if (req.headers['content-type']?.includes('application/json')) {
      const body = JSON.parse(rawBody);
      commandText = body.text;
      userName = body.user_name || 'unknown';
    } else {
      const form = parseFormBody(rawBody);
      commandText = form.text;
      userName = form.user_name || 'unknown';
      userId = form.user_id;
    }

    if (!commandText?.trim()) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response_type: 'ephemeral',
        text: 'Usage: `/card Name | Phone | platform:@handle | tone | email | price-cap`\n\nExample: `/card James Smith | 07700 900123 | instagram:@jsmith | bright and fun | james@gmail.com`',
      }));
      return;
    }

    let parsed;
    try {
      // Support raw JSON input too (for CLI testing)
      parsed = commandText.trim().startsWith('{')
        ? JSON.parse(commandText)
        : parseCardCommand(commandText);
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response_type: 'ephemeral', text: `Parse error: ${err.message}` }));
      return;
    }

    if (!parsed.name) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response_type: 'ephemeral', text: 'Name is required as the first field.' }));
      return;
    }

    if (!parsed.email) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response_type: 'ephemeral', text: 'Recipient email is required (5th field). Example: `/card James Smith | 07700 900123 | instagram:@jsmith | fun | james@gmail.com`' }));
      return;
    }

    // Acknowledge Slack immediately (Slack has a 3-second timeout)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      response_type: 'in_channel',
      text: `*CardDrop started* for *${parsed.name}*\nFinding domain, building site, setting up email... (takes ~2 minutes)`,
    }));

    // Run provisioning in background
    console.log(`[card-http] Request from @${userName}: ${commandText}`);
    provisionCard(parsed).catch(err => {
      console.error('[card-http] Provision error:', err.message);
      const slackUrl = process.env.SLACK_DM;
      if (slackUrl) {
        fetch(slackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `*CardDrop failed* — ${parsed.name}\n${err.message}` }),
        }).catch(() => {});
      }
    });

    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`CardDrop HTTP listener running on port ${PORT}`);
  console.log(`  POST /card  — Slack slash command endpoint`);
  console.log(`  GET  /health — health check`);
  console.log(`\nSlack slash command format:`);
  console.log(`  /card Name | Phone | platform:@handle | tone | email | price-cap`);
});

server.on('error', err => {
  console.error('Server error:', err.message);
  process.exit(1);
});
