import { runEaMorningBriefing } from '../agents/ea-agent.js';

runEaMorningBriefing()
  .then(() => { console.log('EA morning briefing complete.'); process.exit(0); })
  .catch(err => { console.error('EA morning briefing failed:', err); process.exit(1); });
