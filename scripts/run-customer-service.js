import 'dotenv/config';
import { runCustomerServiceAgent } from '../agents/customer-service-agent.js';

runCustomerServiceAgent()
  .then(() => { console.log('CS agent complete.'); process.exit(0); })
  .catch(err => { console.error('CS agent failed:', err); process.exit(1); });
