import 'dotenv/config';
import { runFinanceAgent } from '../agents/finance-agent.js';

runFinanceAgent()
  .then(r => { console.log('Finance agent complete.'); process.exit(0); })
  .catch(err => { console.error('Finance agent failed:', err); process.exit(1); });
