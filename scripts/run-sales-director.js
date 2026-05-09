import 'dotenv/config';
import { runSalesDirectorAgent } from '../agents/sales-director-agent.js';

runSalesDirectorAgent()
  .then(() => { console.log('Sales director agent complete.'); process.exit(0); })
  .catch(err => { console.error('Sales director agent failed:', err); process.exit(1); });
