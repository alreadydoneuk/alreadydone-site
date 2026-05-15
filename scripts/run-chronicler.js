import { runChroniclerAgent } from '../agents/chronicler-agent.js';

console.log('=== Chronicler Agent ===');
try {
  const result = await runChroniclerAgent();
  console.log(`Chronicler complete: ${result.checked} tasks checked off, ${result.newTasks} new tasks added.`);
  process.exit(0);
} catch (err) {
  console.error('Chronicler crashed:', err);
  process.exit(1);
}
