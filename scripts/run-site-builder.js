import { runSiteBuilderAgent } from '../agents/site-builder-agent.js';
import { alert } from '../lib/slack.js';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(__dirname, 'deploy-site.sh');

console.log('=== Site Builder Agent ===');

let result;
try {
  result = await runSiteBuilderAgent();
  console.log(`Result: ${result.built} sites built`);
} catch (err) {
  console.error('Site builder crashed:', err);
  await alert('Site builder crashed', `\`${err.message}\``);
  process.exit(1);
}

if (result.built > 0) {
  console.log('\nDeploying preview sites to alreadydone.uk...');
  try {
    execSync(`bash "${DEPLOY_SCRIPT}"`, { stdio: 'inherit' });
  } catch (err) {
    console.error('Deploy failed:', err.message);
    await alert(
      `Deploy failed — ${result.built} site(s) built but not yet live`,
      `Preview sites were built successfully but the Cloudflare Pages deploy failed.\n\nRun \`bash scripts/deploy-site.sh\` to deploy manually.\n\nError: \`${err.message}\``
    );
    // Exit 0 — builds succeeded; deploy is recoverable by re-running deploy-site.sh
    process.exit(0);
  }
}
