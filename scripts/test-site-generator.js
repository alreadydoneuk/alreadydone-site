// Quick standalone test — generates one site and screenshots it.
// Only needs ANTHROPIC_API_KEY in .env
import { generateSite } from '../lib/claude.js';
import { screenshotSite, generateSlug } from '../lib/screenshot.js';
import { writeFileSync } from 'fs';
import 'dotenv/config';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY in .env first');
  process.exit(1);
}

const testBusiness = {
  name: "Dave's Plumbing Services",
  category: 'plumber',
  location: 'Shrewsbury',
  address: '14 Castle Street, Shrewsbury, SY1 2BQ',
  phone: '01743 555 123',
};

console.log(`Generating site for: ${testBusiness.name}...`);
const html = await generateSite(testBusiness);
console.log(`Generated ${html.length} chars of HTML`);

const slug = generateSlug(testBusiness.name, testBusiness.location);
const { screenshotPath } = await screenshotSite(slug, html);

console.log(`\n✓ Screenshot saved to: ${screenshotPath}`);
console.log(`  Open with: xdg-open ${screenshotPath}`);
