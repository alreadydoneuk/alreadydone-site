import { runArticleAgent } from '../agents/article-agent.js';

const result = await runArticleAgent();
if (result.generated) {
  console.log(`✓ Article published: ${result.title}`);
} else {
  console.log('No article generated this run.');
}
