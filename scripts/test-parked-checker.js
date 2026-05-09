// Test the parked domain detector against a handful of real domains.
// No API keys needed.
import { checkDomain } from '../lib/parked.js';

const testDomains = [
  // Likely parked or broken — real examples of patterns we target
  'https://example-parked-domain.co.uk',     // will probably be broken
  'https://bbc.co.uk',                        // definitely live
  'https://google.com',                       // definitely live
  'http://expired-and-parked.co.uk',          // likely broken
];

// Also test with your own domain examples if you have them
const args = process.argv.slice(2);
if (args.length) testDomains.push(...args);

console.log('Testing domain status checker...\n');

for (const domain of testDomains) {
  const status = await checkDomain(domain);
  const icon = { live: '✅', parked: '🅿️', broken: '❌', none: '—' }[status] || '?';
  console.log(`${icon} [${status.padEnd(6)}] ${domain}`);
}
