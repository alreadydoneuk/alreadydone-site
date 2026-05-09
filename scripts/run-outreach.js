import { runOutreachAgent } from '../agents/outreach-agent.js';
import { alert } from '../lib/slack.js';

console.log('=== Outreach Agent ===');

try {
  const result = await runOutreachAgent();
  console.log('Result:', result);
} catch (err) {
  console.error('Outreach agent crashed:', err);
  await alert('Outreach agent crashed', `\`${err.message}\``);
  process.exit(1);
}
