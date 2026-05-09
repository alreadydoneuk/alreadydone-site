import { runFollowUpAgent } from '../agents/follow-up-agent.js';

console.log('=== Follow-up Agent ===');
try {
  const result = await runFollowUpAgent();
  console.log(`Sent: ${result.sent} follow-ups | Dropped: ${result.dropped} timed-out`);
} catch (err) {
  console.error('Follow-up agent crashed:', err);
  process.exit(1);
}
