import { runDomainExpiryAgent } from '../agents/domain-expiry-agent.js';

const result = await runDomainExpiryAgent();
console.log('Domain expiry result:', result);
