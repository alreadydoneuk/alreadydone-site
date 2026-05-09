import { Resend } from 'resend';
import 'dotenv/config';

let _resend = null;

function getClient() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set in .env');
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

export async function sendOutreachEmail({ to, subject, body, previewUrl, screenshotPath }) {
  const resend = getClient();

  const testEmail = process.env.TEST_EMAIL;
  const actualTo = testEmail || to;

  if (testEmail) {
    console.log(`    ⚠️  TEST MODE — redirecting to ${testEmail} (would have gone to ${to})`);
    subject = `[TEST → ${to}] ${subject}`;
  }

  const html = plainToHtml(body, previewUrl);

  const attachments = [];
  if (screenshotPath) {
    const { readFileSync } = await import('fs');
    try {
      const content = readFileSync(screenshotPath).toString('base64');
      attachments.push({ filename: 'your-website-preview.png', content });
    } catch {
      console.warn('    Screenshot not found — sending without attachment');
    }
  }

  const { data, error } = await resend.emails.send({
    from: `${process.env.FROM_NAME || 'Dean'} <${process.env.FROM_EMAIL || 'dean@alreadydone.uk'}>`,
    to: actualTo,
    subject,
    text: previewUrl ? `${body}\n\nView the site: ${previewUrl}` : body,
    html,
    attachments: attachments.length ? attachments : undefined,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);

  // Resend sets Message-ID as <{id}@resend.dev> in the actual email headers.
  // Store without angle brackets so reply-monitor's inReplyTo comparison matches.
  const messageId = `${data.id}@resend.dev`;
  console.log(`    Sent via Resend — id: ${data.id}`);
  return { messageId };
}

export async function sendAutoReply({ to, subject, body, inReplyTo }) {
  const resend = getClient();

  const { data, error } = await resend.emails.send({
    from: `${process.env.FROM_NAME || 'Dean'} <${process.env.FROM_EMAIL || 'dean@alreadydone.uk'}>`,
    to,
    subject,
    text: body,
    html: plainToHtml(body, null),
    headers: inReplyTo ? { 'In-Reply-To': inReplyTo, References: inReplyTo } : undefined,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`    Auto-reply sent — id: ${data.id}`);
  return { messageId: `${data.id}@resend.dev` };
}

export async function sendCustomerReport({ to, firstName, domain, monthsLive, renewalDate }) {
  const resend = getClient();
  const name = firstName || 'there';

  const renewalLine = renewalDate
    ? `Your domain and hosting renew automatically on ${renewalDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. No action needed.`
    : 'Your domain and hosting renew automatically in about a year. No action needed.';

  const liveNote = monthsLive && monthsLive > 0
    ? `Your website has been live for ${monthsLive} month${monthsLive !== 1 ? 's' : ''} now.`
    : 'Your website is live and running.';

  const lines = [
    `Hi ${name},`,
    ``,
    `Just a quick check-in from Already Done.`,
    ``,
    `${liveNote} Everything is working as it should — hosting, domain, SSL.`,
    ``,
    `Your site: https://${domain}`,
    ``,
    `${renewalLine}`,
    ``,
    `If you'd like any changes — a new phone number, updated hours, anything like that — just reply to this email and I'll sort it.`,
    ``,
    `Dean`,
    `Already Done`,
  ];

  const body = lines.join('\n');

  const { data, error } = await resend.emails.send({
    from: `${process.env.FROM_NAME || 'Dean'} <${process.env.FROM_EMAIL || 'dean@alreadydone.uk'}>`,
    to,
    subject: `Your website update — ${domain}`,
    text: body,
    html: plainToHtml(body, `https://${domain}`),
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`    Customer report sent — id: ${data.id}`);
  return { messageId: data.id };
}

export async function sendOnboardingStarted({ to, firstName, domain, emailPrefix, plan }) {
  const resend = getClient();
  const name = firstName || 'there';
  const hasEmail = plan === 'site_and_email' && emailPrefix;

  const lines = [
    `Hi ${name},`,
    '',
    `Payment confirmed — we're building your website now.`,
    '',
    `Here's what's happening:`,
    `  → Registering ${domain}`,
    `  → Building your site`,
    ...(hasEmail ? [`  → Setting up ${emailPrefix}@${domain}`] : []),
    '',
    `You'll get a second email from us within 30 minutes once everything is live and tested.${hasEmail ? ' That email will have your website link and full instructions for setting up your email on your phone.' : ' That email will have your live website link.'}`,
    '',
    `No action needed from you right now.`,
    '',
    `Dean`,
    `Already Done`,
  ];

  const body = lines.join('\n');

  const { data, error } = await resend.emails.send({
    from: `${process.env.FROM_NAME || 'Dean'} <${process.env.FROM_EMAIL || 'dean@alreadydone.uk'}>`,
    to,
    subject: `Your website is being built — ready in about 30 minutes`,
    text: body,
    html: plainToHtml(body, null),
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`    Onboarding Email 1 sent — id: ${data.id}`);
  return { messageId: data.id };
}

export async function sendOnboardingComplete({ to, firstName, domain, emailPrefix, emailPassword, plan, extraAccounts = [] }) {
  const resend = getClient();
  const name = firstName || 'there';
  const hasEmail = plan === 'site_and_email' && emailPrefix && emailPassword;

  const allAccounts = hasEmail
    ? [{ prefix: emailPrefix, password: emailPassword }, ...extraAccounts]
    : [];

  const emailBlock = hasEmail ? [
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `YOUR EMAIL`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ...allAccounts.map(a => `Address:  ${a.prefix}@${domain}    Password: ${a.password}`),
    ``,
    `Set it up on your phone (takes 2 minutes):`,
    ``,
    `iPhone`,
    `Settings → Mail → Add Account → Other → Add Mail Account`,
    `  Name:     ${name}`,
    `  Email:    ${emailPrefix}@${domain}`,
    `  Password: ${emailPassword}`,
    `  Description: My Business Email`,
    `Then:`,
    `  Incoming: imap.forwardemail.net  Port 993  SSL`,
    `  Outgoing: smtp.forwardemail.net  Port 465  SSL`,
    ``,
    `Android / Outlook`,
    `Add account → Other / IMAP → enter the same settings above.`,
    ...(extraAccounts.length > 0 ? [``, `Your other address(es) use the same settings with their own address and password.`] : []),
  ] : [];

  const lines = [
    `Hi ${name},`,
    ``,
    `Everything is live. Here's what you've got:`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `YOUR WEBSITE`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `https://${domain}`,
    ...emailBlock,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `RENEWAL`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Everything renews automatically one year from today.`,
    `You'll get an email before it happens. No surprises.`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Any questions — reply to this email.`,
    ``,
    `Dean`,
    `Already Done`,
    `alreadydone.uk`,
  ];

  const body = lines.join('\n');

  const recipients = [to];
  if (hasEmail) recipients.push(`${emailPrefix}@${domain}`);

  const { data, error } = await resend.emails.send({
    from: `${process.env.FROM_NAME || 'Dean'} <${process.env.FROM_EMAIL || 'dean@alreadydone.uk'}>`,
    to: recipients,
    subject: `Your website is live — everything you need inside`,
    text: body,
    html: plainToOnboardingHtml(name, domain, hasEmail ? { prefix: emailPrefix, password: emailPassword, extra: extraAccounts } : null),
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`    Onboarding Email 2 sent — id: ${data.id}`);
  return { messageId: data.id };
}

function plainToOnboardingHtml(name, domain, email) {
  const p = 'margin:0 0 10px;font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#333;';

  const section = (title, content) => `
    <div style="margin:0 0 24px;">
      <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:2px;color:#6b7280;border-top:2px solid #e5e7eb;padding-top:12px;margin-bottom:12px;">${title}</div>
      ${content}
    </div>`;

  const allAccounts = email ? [{ prefix: email.prefix, password: email.password }, ...(email.extra || [])] : [];
  const extraRows = allAccounts.slice(1).map(a =>
    `<tr><td style="padding:4px 8px 4px 0;color:#6b7280;">${a.prefix}@${domain}</td><td style="padding:4px 0;"><code style="background:#f3f4f6;padding:2px 6px;border-radius:3px;">${a.password}</code></td></tr>`
  ).join('');

  const emailSection = email ? section('YOUR EMAIL', `
    <p style="${p}"><strong>${email.prefix}@${domain}</strong><br>
    Password: <code style="background:#f3f4f6;padding:2px 6px;border-radius:3px;">${email.password}</code></p>
    ${extraRows ? `<table style="margin-bottom:10px;border-collapse:collapse;">${extraRows}</table>` : ''}
    <p style="${p}">Set up on your phone (takes 2 minutes):</p>
    <p style="${p}"><strong>iPhone</strong><br>
    Settings &rarr; Mail &rarr; Add Account &rarr; Other &rarr; Add Mail Account<br>
    Incoming: <strong>imap.forwardemail.net</strong> Port 993 SSL<br>
    Outgoing: <strong>smtp.forwardemail.net</strong> Port 465 SSL</p>
    <p style="${p}"><strong>Android / Outlook</strong><br>
    Add account &rarr; Other / IMAP &rarr; same settings above.</p>
  `) : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="max-width:600px;margin:0 auto;padding:30px 20px;background:#fff;">
  <p style="${p}">Hi ${name},</p>
  <p style="${p}">Everything is live. Here's what you've got:</p>
  ${section('YOUR WEBSITE', `<p style="${p}"><a href="https://${domain}" style="color:#1d4ed8;font-weight:600;">https://${domain}</a></p>`)}
  ${emailSection}
  ${section('RENEWAL', `<p style="${p}">Everything renews automatically one year from today. You'll get an email before it happens. No surprises.</p>`)}
  <p style="${p}">Any questions — reply to this email.</p>
  <p style="${p}">Dean<br>Already Done<br><a href="https://alreadydone.uk" style="color:#6b7280;">alreadydone.uk</a></p>
</body>
</html>`;
}

function plainToHtml(text, previewUrl) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n')
    .map(line => line.trim()
      ? `<p style="margin:0 0 12px;font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#333;">${line}</p>`
      : '<br>')
    .join('');

  const button = previewUrl ? `
  <div style="margin:16px 0 28px;">
    <a href="${previewUrl}"
       style="display:inline-block;padding:14px 28px;background:#1d4ed8;color:#fff;font-family:Arial,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">
      View your website →
    </a>
  </div>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="max-width:600px;margin:0 auto;padding:30px 20px;background:#fff;">
  ${escaped}
  ${button}
</body>
</html>`;
}
