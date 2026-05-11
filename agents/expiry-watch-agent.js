// Expiry Watch Agent
// Runs daily. Checks all businesses in expiry_watch pipeline_status:
//   1. Re-fetches WHOIS — most will have renewed, update expiry date and stay in watch
//   2. If domain still expiring within TRIGGER_DAYS — move to researched so site builder
//      picks it up, or if site already built move to template_built for outreach
//   3. Logs all outcomes to interactions table

import { supabase, updateBusiness, logInteraction } from '../lib/db.js';
import { lookupWhois } from '../lib/directory-finder.js';
import { alert } from '../lib/slack.js';
import 'dotenv/config';

const TRIGGER_DAYS = 90;  // build/email when expiry is within 90 days
const BATCH_SIZE   = 50;  // WHOIS lookups per run (free, but rate-limit politely)

export async function runExpiryWatchAgent() {
  const { data: watchList, error } = await supabase
    .from('businesses')
    .select('id,name,category,location,domain,email,website_status,whois_expiry_date,site_slug,preview_url,template_screenshot')
    .eq('pipeline_status', 'expiry_watch')
    .not('domain', 'is', null)
    .order('whois_expiry_date', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) throw error;

  if (!watchList?.length) {
    console.log('Expiry watch: nothing to check');
    return { checked: 0, triggered: 0, renewed: 0 };
  }

  console.log(`\nExpiry watch: checking ${watchList.length} businesses`);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let checked = 0, triggered = 0, renewed = 0, failed = 0;
  const triggeredNames = [];

  for (const business of watchList) {
    checked++;
    console.log(`\n  ${business.name} [${business.website_status}] — stored expiry: ${business.whois_expiry_date || 'unknown'}`);

    // Re-check WHOIS
    let newExpiry = null;
    try {
      const whoisData = await lookupWhois(business.domain);
      if (whoisData?.expiry_date) {
        newExpiry = whoisData.expiry_date;
        if (newExpiry !== business.whois_expiry_date) {
          console.log(`    WHOIS updated: ${business.whois_expiry_date} → ${newExpiry}`);
          await updateBusiness(business.id, {
            whois_expiry_date: newExpiry,
            whois_attempted_at: new Date().toISOString(),
          });
        } else {
          console.log(`    WHOIS unchanged: ${newExpiry}`);
          await updateBusiness(business.id, { whois_attempted_at: new Date().toISOString() });
        }
      } else {
        // WHOIS lookup returned nothing — domain may have been dropped or privacy enabled
        console.log(`    WHOIS: no data returned`);
        failed++;
      }
    } catch (err) {
      console.log(`    WHOIS error: ${err.message}`);
      failed++;
    }

    const expiryToCheck = newExpiry || business.whois_expiry_date;
    if (!expiryToCheck) continue;

    const expiryDate = new Date(expiryToCheck); expiryDate.setHours(0, 0, 0, 0);
    const daysUntilExpiry = Math.round((expiryDate - today) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiry > TRIGGER_DAYS) {
      // Still far away — stays in watch
      console.log(`    Still ${daysUntilExpiry} days away — staying in watch`);
      await logInteraction(business.id, 'expiry_watch', 'internal',
        `Re-checked WHOIS: ${daysUntilExpiry} days until expiry (${expiryToCheck}). Staying in watch.`,
        null, { days_until_expiry: daysUntilExpiry, whois_expiry_date: expiryToCheck }
      );
    } else if (daysUntilExpiry < 0) {
      // Already expired — if domain renewed, WHOIS would show new date. This means it's truly gone.
      console.log(`    ⚠️  Domain appears expired (${daysUntilExpiry}d) — dropping from watch`);
      await updateBusiness(business.id, {
        pipeline_status: 'dropped',
        drop_reason: 'domain_expired_in_watch',
        dropped_at_stage: 'expiry_watch',
      });
      await logInteraction(business.id, 'expiry_watch', 'internal',
        `Domain expired without renewal (expiry: ${expiryToCheck}). Dropping from pipeline.`
      );
    } else {
      // Within trigger window — activate for build or outreach
      triggered++;
      triggeredNames.push(`${business.name} (${daysUntilExpiry}d)`);

      if (business.preview_url) {
        // Site already built — move straight to template_built for outreach
        console.log(`    🔔 Triggered — site built, moving to template_built for outreach (${daysUntilExpiry}d to expiry)`);
        await updateBusiness(business.id, { pipeline_status: 'template_built' });
        await logInteraction(business.id, 'expiry_watch', 'internal',
          `Triggered: ${daysUntilExpiry} days until expiry. Site already built — moved to template_built for outreach.`,
          null, { days_until_expiry: daysUntilExpiry, whois_expiry_date: expiryToCheck }
        );
      } else {
        // No site yet — move back to researched so site builder picks it up
        console.log(`    🔔 Triggered — moving to researched for site build (${daysUntilExpiry}d to expiry)`);
        await updateBusiness(business.id, { pipeline_status: 'researched' });
        await logInteraction(business.id, 'expiry_watch', 'internal',
          `Triggered: ${daysUntilExpiry} days until expiry. No site built yet — moved to researched for build.`,
          null, { days_until_expiry: daysUntilExpiry, whois_expiry_date: expiryToCheck }
        );
      }

      renewed++;
    }

    // Polite delay between WHOIS lookups
    await sleep(1000);
  }

  console.log(`\nExpiry watch complete: ${checked} checked, ${triggered} triggered, ${failed} WHOIS failures\n`);

  if (triggered > 0) {
    await alert(
      `⏰ Expiry watch: ${triggered} domain${triggered > 1 ? 's' : ''} coming due`,
      triggeredNames.join('\n')
    ).catch(() => {});
  }

  return { checked, triggered, renewed, failed };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
