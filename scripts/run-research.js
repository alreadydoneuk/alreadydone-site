import { runResearchAgent } from '../agents/research-agent.js';

console.log('=== Research Agent ===');

try {
  const result = await runResearchAgent();
  console.log('Result:', result);
} catch (err) {
  console.error('Research agent crashed:', err);
  process.exit(1);
}
