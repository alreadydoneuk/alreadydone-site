import { runSiteBuilderAgent } from '../agents/site-builder-agent.js';
import { alert } from '../lib/slack.js';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(__dirname, 'deploy-site.sh');

console.log('=== Site Builder Agent ===');

try {
  const result = await runSiteBuilderAgent();
  console.log(`Result: ${result.built} sites built`);

  if (result.built > 0) {
    console.log('\nDeploying preview sites to alreadydone.uk...');
    execSync(`bash "${DEPLOY_SCRIPT}"`, { stdio: 'inherit' });
  }
} catch (err) {
  console.error('Site builder crashed:', err);
  await alert('Site builder crashed', `\`${err.message}\``);
  process.exit(1);
}
