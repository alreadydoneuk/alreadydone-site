import { runEnrichmentAgent } from '../agents/enrichment-agent.js';

console.log('=== Enrichment Agent ===');

try {
  const result = await runEnrichmentAgent();
  console.log('Result:', result);
} catch (err) {
  console.error('Enrichment agent crashed:', err);
  process.exit(1);
}
