// One-shot backlog drain — processes every unenriched business until the queue is empty.
// Safe to re-run: businesses with serper_attempted_at already set are skipped.
import { runEnrichmentAgent } from '../agents/enrichment-agent.js';

console.log('=== Enrichment Backlog Drain ===');
console.log('Processing all unenriched businesses until queue is empty...\n');

try {
  const result = await runEnrichmentAgent({ drainAll: true });
  console.log('Done:', result);
} catch (err) {
  console.error('Backlog drain crashed:', err);
  process.exit(1);
}
