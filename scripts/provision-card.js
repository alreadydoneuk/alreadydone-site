#!/usr/bin/env node
/**
 * CardDrop — provision a personal business card site + email in one shot.
 *
 * Usage:
 *   node scripts/provision-card.js '<json>'
 *
 * JSON shape:
 * {
 *   "name":       "James Smith",
 *   "phone":      "07700 900123",       // optional
 *   "email":      "james@gmail.com",    // where to SEND the card details
 *   "socials":    [{"platform":"instagram","handle":"@jsmith"}],
 *   "tone":       "bright and fun",
 *   "priceCap":   15,                   // USD, default 15
 *   "emailPrefix":"james"              // optional, defaults to first name slug
 * }
 */

import { checkDomain, registerDomain, pointToCloudflarePages, addDnsRecord, deleteDnsRecordsByType, slugify } from '../lib/domains.js';
import { addEmailDnsRecords, provisionEmailAddresses } from '../lib/email-provisioning.js';
import { generateBusinessCard } from '../lib/card-generator.js';
import { Resend } from 'resend';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import 'dotenv/config';

const CF_ACCOUNT_ID = 'c663467f92484cce5de42806e1a1e868';
const PAGES_PROJECT_PREFIX = 'carddrop-';
const PRICE_CAP_DEFAULT = 15;

// TLDs to try in order of preference
const CARD_TLDS = ['.com', '.co.uk', '.uk', '.me', '.online', '.io', '.site', '.xyz'];

async function findAvailableDomain(name, priceCap) {
  const slug = slugify(name);
  const noDash = slug.replace(/-/g, '');
  const candidates = [];

  for (const tld of CARD_TLDS) {
    if (noDash !== slug) candidates.push(`${noDash}${tld}`);
    candidates.push(`${slug}${tld}`);
  }

  // Deduplicate
  const seen = new Set();
  const unique = candidates.filter(d => { if (seen.has(d)) return false; seen.add(d); return true; });

  console.log(`[carddrop] Checking ${unique.length} domain candidates for "${name}"...`);

  for (const domain of unique) {
    const result = await checkDomain(domain);
    if (!result.available) {
      console.log(`  ${domain} — taken`);
      continue;
    }
    const price = result.priceUsd ?? 0;
    const cap = priceCap ?? PRICE_CAP_DEFAULT;
    if (price > cap) {
      console.log(`  ${domain} — available but $${price.toFixed(2)} > cap $${cap}`);
      continue;
    }
    console.log(`  ${domain} — available $${price.toFixed(2)}/yr ✓`);
    return { domain, priceUsd: price };
  }

  throw new Error(`No domain found under $${priceCap ?? PRICE_CAP_DEFAULT} for "${name}" across TLDs: ${CARD_TLDS.join(', ')}`);
}

async function deploy(html, projectName) {
  const tmpDir = `/tmp/carddrop-${projectName}`;
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(`${tmpDir}/index.html`, html);

  console.log(`[carddrop] Deploying to Cloudflare Pages (${projectName})...`);
  const out = execSync(
    `CLOUDFLARE_API_TOKEN="${process.env.CLOUDFLARE_TOKEN}" CLOUDFLARE_ACCOUNT_ID="${CF_ACCOUNT_ID}" npx wrangler pages deploy "${tmpDir}" --project-name="${projectName}"`,
    { encoding: 'utf8', timeout: 120000 }
  );

  rmSync(tmpDir, { recursive: true, force: true });

  const match = out.match(/https?:\/\/([a-z0-9-]+\.pages\.dev)/);
  if (!match) throw new Error(`Could not parse pages.dev hostname from wrangler output:\n${out}`);
  return match[1];
}

async function addCustomDomainToPages(projectName, domain) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${projectName}/domains`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: domain }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    if (!body.includes('already exists')) {
      console.warn(`[carddrop] Cloudflare custom domain warning: ${res.status} ${body}`);
    }
  }
}

async function sendWelcomeEmail({ recipientEmail, name, domain, emailAddress, emailPassword }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const firstName = name.split(' ')[0];
  const hasEmail = !!(emailAddress && emailPassword);

  const emailLines = hasEmail ? [
    ``,
    `YOUR EMAIL`,
    `──────────`,
    `Address:  ${emailAddress}`,
    `Password: ${emailPassword}`,
    ``,
    `Set it up on your phone:`,
    ``,
    `iPhone → Settings → Mail → Add Account → Other → Add Mail Account`,
    `  Incoming: imap.forwardemail.net  Port 993  SSL`,
    `  Outgoing: smtp.forwardemail.net  Port 465  SSL`,
    ``,
    `Android / Outlook → Add account → Other / IMAP → same settings above.`,
  ] : [];

  const text = [
    `Hi ${firstName},`,
    ``,
    `Your digital card is live.`,
    ``,
    `YOUR CARD`,
    `─────────`,
    `https://${domain}`,
    ...emailLines,
    ``,
    `Share the link anywhere. It'll look great on any device.`,
    ``,
    `Rougvie`,
  ].join('\n');

  const html = buildWelcomeHtml({ firstName, domain, emailAddress, emailPassword, hasEmail });

  const recipients = [recipientEmail];
  if (hasEmail) recipients.push(emailAddress);

  const { data, error } = await resend.emails.send({
    from: `Rougvie <hello@rougvie.com>`,
    to: recipients,
    subject: `Your digital card is live — ${domain}`,
    text,
    html,
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[carddrop] Welcome email sent — ${data.id}`);
}

function buildWelcomeHtml({ firstName, domain, emailAddress, emailPassword, hasEmail }) {
  const p = 'margin:0 0 12px;font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#333;';
  const label = 'font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:2px;color:#6b7280;border-top:2px solid #e5e7eb;padding-top:12px;margin:24px 0 10px;';
  const code = 'background:#f3f4f6;padding:2px 6px;border-radius:3px;font-size:13px;';

  const emailBlock = hasEmail ? `
    <p style="${label}">YOUR EMAIL</p>
    <p style="${p}">
      <strong>${emailAddress}</strong><br>
      Password: <code style="${code}">${emailPassword}</code>
    </p>
    <p style="${p}">Set it up on your phone (takes 2 minutes):</p>
    <p style="${p}">
      <strong>iPhone</strong> → Settings → Mail → Add Account → Other → Add Mail Account<br>
      Incoming: <strong>imap.forwardemail.net</strong> Port 993 SSL<br>
      Outgoing: <strong>smtp.forwardemail.net</strong> Port 465 SSL
    </p>
    <p style="${p}"><strong>Android / Outlook</strong> → Add account → Other / IMAP → same settings.</p>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="max-width:580px;margin:0 auto;padding:32px 20px;background:#fff;">
  <p style="${p}">Hi ${firstName},</p>
  <p style="${p}">Your digital card is live.</p>
  <p style="${label}">YOUR CARD</p>
  <p style="${p}"><a href="https://${domain}" style="color:#1d4ed8;font-weight:600;font-size:17px;">https://${domain}</a></p>
  ${emailBlock}
  <p style="${p}">Share the link anywhere — it looks great on any device.</p>
  <p style="${p}">Rougvie</p>
</body>
</html>`;
}

async function postToSlack(text) {
  const url = process.env.SLACK_DM;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function provisionCard(input) {
  const {
    name,
    phone,
    email: recipientEmail,
    socials = [],
    tone = 'minimal and professional',
    priceCap,
    emailPrefix: rawPrefix,
  } = input;

  if (!name) throw new Error('name is required');
  if (!recipientEmail) throw new Error('email (recipient) is required');

  const prefix = rawPrefix || slugify(name.split(' ')[0]);

  console.log(`\n[carddrop] Starting: ${name}`);
  console.log(`  Tone: ${tone}`);
  console.log(`  Socials: ${socials.map(s => `${s.platform}:${s.handle}`).join(', ') || 'none'}`);

  // 1. Find domain
  const { domain, priceUsd } = await findAvailableDomain(name, priceCap);

  // 2. Register domain
  await registerDomain(domain, { costUsd: priceUsd });
  console.log(`[carddrop] Registered: ${domain}`);

  // 3. Set email DNS records first (long TTL propagation)
  await addEmailDnsRecords(domain);
  console.log(`[carddrop] Email DNS set`);

  // 4. Provision ForwardEmail mailbox
  const emailAddress = `${prefix}@${domain}`;
  const [emailAccount] = await provisionEmailAddresses(domain, 1, [prefix]);
  console.log(`[carddrop] Mailbox: ${emailAddress}`);

  // 5. Generate the business card HTML
  console.log(`[carddrop] Generating card HTML...`);
  const html = await generateBusinessCard({ name, phone, socials, tone, domain, email: emailAddress });

  // 6. Deploy to Cloudflare Pages
  const projectName = `${PAGES_PROJECT_PREFIX}${slugify(name)}`.slice(0, 63);
  const pagesHostname = await deploy(html, projectName);
  console.log(`[carddrop] Pages: ${pagesHostname}`);

  // 7. Point domain DNS at Cloudflare Pages
  await pointToCloudflarePages(domain, pagesHostname);
  console.log(`[carddrop] DNS → ${pagesHostname}`);

  // 8. Add custom domain to Pages project
  await addCustomDomainToPages(projectName, domain);

  // 9. Send welcome email
  await sendWelcomeEmail({
    recipientEmail,
    name,
    domain,
    emailAddress,
    emailPassword: emailAccount?.password,
  });

  const result = { domain, emailAddress, emailPassword: emailAccount?.password, pagesHostname };

  // 10. Notify Slack
  await postToSlack(
    `*CardDrop* — ${name}\n` +
    `Card: https://${domain}\n` +
    `Email: ${emailAddress}\n` +
    `Tone: ${tone}`
  );

  console.log(`\n[carddrop] Done — https://${domain}`);
  return result;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('provision-card.js')) {
  const raw = process.argv[2];
  if (!raw) {
    console.error('Usage: node scripts/provision-card.js \'{"name":"...","email":"...","tone":"..."}\'');
    process.exit(1);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    console.error('Invalid JSON input');
    process.exit(1);
  }
  provisionCard(input).catch(err => {
    console.error('[carddrop] Fatal:', err.message);
    postToSlack(`*CardDrop failed*\n${err.message}`).finally(() => process.exit(1));
  });
}
