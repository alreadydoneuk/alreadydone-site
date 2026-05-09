import { runMonthlyReportAgent } from '../agents/monthly-report-agent.js';
import { alert } from '../lib/slack.js';

console.log('=== Monthly Report Agent ===');

try {
  const result = await runMonthlyReportAgent();
  console.log(`Result: ${result.fullSent || 0} full, ${result.trialSent || 0} free trial`);
} catch (err) {
  console.error('Monthly report agent crashed:', err);
  await alert('Monthly report agent crashed', `\`${err.message}\``);
  process.exit(1);
}
