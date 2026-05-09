import 'dotenv/config';
import { runLdAgent } from '../agents/ld-agent.js';

runLdAgent()
  .then(() => { console.log('LD agent complete.'); process.exit(0); })
  .catch(err => { console.error('LD agent failed:', err); process.exit(1); });
