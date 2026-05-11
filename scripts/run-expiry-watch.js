import { runExpiryWatchAgent } from '../agents/expiry-watch-agent.js';
import 'dotenv/config';

console.log('=== Expiry Watch Agent ===');
const result = await runExpiryWatchAgent();
console.log('Result:', result);
