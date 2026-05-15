// Autonomous research pipeline — Edinburgh outward by default.
// Usage:
//   node scripts/run-pipeline.js                  # auto-expands Edinburgh → outward
//   node scripts/run-pipeline.js --area Edinburgh  # focus one area
//   node scripts/run-pipeline.js --daily-limit 200 # stay under API cap

import { runResearchAgent } from '../agents/research-agent.js';
import { getVerifiedLeadCount, getAreaProgress } from '../lib/db.js';
import { expansionOrder } from '../seeds/expansion-order.js';
import 'dotenv/config';

const args = process.argv.slice(2);
function getArg(flag) { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; }

const AREA_ARG     = getArg('--area') || null;
const DELAY_MS     = parseInt(getArg('--delay-secs') || process.env.DELAY_SECS || '10') * 1000;
// Places API Text Search Enterprise SKU: £0.026/req (£25.95/1,000) after first 1,000/month free.
// Google Maps $200/month credit (~£160) covers ~6,150 more req/month after the free 1,000.
// Total free per month: ~7,150 requests = ~238/day. Default 200 gives a safe buffer.
// Note: each queue item uses 1–3 actual HTTP requests (pagination), tracked accurately below.
const DAILY_LIMIT  = parseInt(getArg('--daily-limit') || process.env.DAILY_LIMIT || '200');

let requestsToday = 0;
let currentDayKey = new Date().toDateString();

function checkDailyLimit() {
  const today = new Date().toDateString();
  if (today !== currentDayKey) { requestsToday = 0; currentDayKey = today; }
  return requestsToday < DAILY_LIMIT;
}

console.log(`\n=== Found Local — Research Pipeline ===`);
console.log(`Mode:        ${AREA_ARG ? `area lock (${AREA_ARG})` : 'Edinburgh outward'}`);
console.log(`Delay:       ${DELAY_MS / 1000}s between runs`);
console.log(`Daily limit: ${DAILY_LIMIT} API requests\n`);

// Determine which area to scan next (first in expansion order with pending items)
async function getNextArea() {
  for (const area of expansionOrder) {
    const { pending } = await getAreaProgress(area);
    if (pending > 0) return area;
  }
  return null;
}

let round = 0;
let area = AREA_ARG;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

while (true) {
  if (!checkDailyLimit()) {
    console.log(`\nDaily API limit reached (${DAILY_LIMIT} requests). Stopping — run again tomorrow.\n`);
    break;
  }

  try {
    // Auto-select next area if not locked to one
    if (!AREA_ARG) {
      area = await getNextArea();
      if (!area) {
        console.log('\nAll areas in expansion order fully scanned. Add more locations to continue.\n');
        break;
      }
    }

    const { pending, complete, total } = await getAreaProgress(area);
    const prospects = await getVerifiedLeadCount();

    console.log(`[Round ${++round}] ${area} — ${complete}/${total} categories | ${prospects} prospects | ${requestsToday}/${DAILY_LIMIT} API calls today`);

    if (pending === 0) {
      if (AREA_ARG) {
        console.log(`\n✓ ${area} fully scanned (${total} categories complete).\n`);
        break;
      }
      consecutiveErrors = 0;
      continue; // auto-mode: getNextArea() will pick the next one
    }

    const result = await runResearchAgent(area);
    requestsToday += result.apiRequests || 1;
    consecutiveErrors = 0;

    if (result.processed === 0 && !AREA_ARG) {
      continue;
    }

    if (result.processed === 0 && AREA_ARG) {
      console.log(`\nQueue exhausted for ${area}.\n`);
      break;
    }

    console.log(`  Waiting ${DELAY_MS / 1000}s...\n`);
    await sleep(DELAY_MS);

  } catch (err) {
    consecutiveErrors++;
    const isTimeout = err?.code === '57014' || err?.message?.includes('statement timeout') || err?.message?.includes('canceling statement');
    console.error(`  Round error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${err?.message || err}`);

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(`\nToo many consecutive errors — stopping pipeline.\n`);
      throw err;
    }

    const backoff = isTimeout ? 30000 : 10000;
    console.log(`  Retrying in ${backoff / 1000}s...\n`);
    await sleep(backoff);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
