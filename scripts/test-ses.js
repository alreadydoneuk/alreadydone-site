// Sends a real test email through SES to verify credentials and deliverability.
// Usage: node scripts/test-ses.js your@email.com

import { sendOutreachEmail } from '../lib/mailer.js';
import 'dotenv/config';

const to = process.argv[2];
if (!to) {
  console.error('Usage: node scripts/test-ses.js your@email.com');
  process.exit(1);
}

if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.error('SMTP_HOST, SMTP_USER, and SMTP_PASS must be set in .env');
  process.exit(1);
}

console.log(`Sending test email to ${to} via ${process.env.SMTP_HOST}...`);

const { messageId } = await sendOutreachEmail({
  to,
  subject: 'Already Done — SES test',
  body: `Hi,\n\nThis is a test email from the Already Done pipeline to confirm Amazon SES is configured correctly.\n\nIf you're reading this, it worked.\n\nRougvie`,
  screenshotPath: null,
});

console.log(`✓ Sent — message ID: ${messageId}`);
