import 'dotenv/config';
import { runEoAgent } from '../agents/eo-agent.js';

runEoAgent()
  .then(() => { console.log('EO agent complete.'); process.exit(0); })
  .catch(err => { console.error('EO agent failed:', err); process.exit(1); });
