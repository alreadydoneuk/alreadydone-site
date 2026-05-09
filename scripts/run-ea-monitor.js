import { runEaMonitor } from '../agents/ea-agent.js';

runEaMonitor()
  .then(fired => {
    if (fired) console.log('EA monitor: new reports routed.');
    process.exit(0);
  })
  .catch(err => { console.error('EA monitor failed:', err); process.exit(1); });
