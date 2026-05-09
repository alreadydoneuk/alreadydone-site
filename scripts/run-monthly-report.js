import { runMonthlyReportAgent } from '../agents/monthly-report-agent.js';
import { alert } from '../lib/slack.js';

console.log('=== Monthly Report Agent ===');

try {
  const result = await runMonthlyReportAgent();
  console.log(`Result: ${result.sent} report(s) sent`);
} catch (err) {
  console.error('Monthly report agent crashed:', err);
  await alert('Monthly report agent crashed', `\`${err.message}\``);
  process.exit(1);
}
