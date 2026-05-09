import { runProvisionAgent } from '../agents/provision-agent.js';
import { alert } from '../lib/slack.js';

console.log('=== Provision Agent ===');

try {
  const result = await runProvisionAgent();
  console.log(`Result: ${result.provisioned} site(s) provisioned`);
} catch (err) {
  console.error('Provision agent crashed:', err);
  await alert('Provision agent crashed', `\`${err.message}\``);
  process.exit(1);
}
