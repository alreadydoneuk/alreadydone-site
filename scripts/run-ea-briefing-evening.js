import { runEaEveningBriefing } from '../agents/ea-agent.js';

runEaEveningBriefing()
  .then(() => { console.log('EA evening briefing complete.'); process.exit(0); })
  .catch(err => { console.error('EA evening briefing failed:', err); process.exit(1); });
