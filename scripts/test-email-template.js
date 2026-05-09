// Preview what a generated email looks like — no API keys needed.
// Calls Claude to write the email, then sends to Ethereal (fake inbox).
import { generateEmail } from '../lib/claude.js';
import { sendOutreachEmail } from '../lib/mailer.js';
import 'dotenv/config';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY in .env first');
  process.exit(1);
}

const testBusiness = {
  name: "Tails & Trails Dog Grooming",
  category: 'dog groomer',
  location: 'Shrewsbury',
  domain: 'tailsandtrails.co.uk',
  price: 99,
};

console.log(`Generating email for: ${testBusiness.name}...`);
const body = await generateEmail(testBusiness, false);

console.log('\n--- EMAIL BODY ---');
console.log(body);
console.log('------------------\n');

console.log('Sending to Ethereal test inbox...');
const { previewUrl } = await sendOutreachEmail({
  to: 'owner@tailsandtrails.co.uk',
  subject: `I built a website for ${testBusiness.name}`,
  body,
  screenshotPath: null,
});

if (previewUrl) {
  console.log(`Open in browser to see rendered email: ${previewUrl}`);
}
