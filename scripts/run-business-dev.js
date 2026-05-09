import 'dotenv/config';
import { runBusinessDevAgent } from '../agents/business-dev-agent.js';

runBusinessDevAgent()
  .then(() => { console.log('BizDev agent complete.'); process.exit(0); })
  .catch(err => { console.error('BizDev agent failed:', err); process.exit(1); });
