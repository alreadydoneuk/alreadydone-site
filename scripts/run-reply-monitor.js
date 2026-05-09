import { runReplyMonitorAgent } from '../agents/reply-monitor-agent.js';

console.log('=== Reply Monitor ===');
try {
  const result = await runReplyMonitorAgent();
  console.log(`Processed: ${result.processed} replies`);
} catch (err) {
  console.error('Reply monitor crashed:', err);
  process.exit(1);
}
