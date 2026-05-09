import 'dotenv/config';
import { runSalesManagerAgent } from '../agents/sales-manager-agent.js';

runSalesManagerAgent()
  .then(() => { console.log('Sales manager agent complete.'); process.exit(0); })
  .catch(err => { console.error('Sales manager agent failed:', err); process.exit(1); });
