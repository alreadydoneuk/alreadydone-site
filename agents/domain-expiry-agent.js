import { supabase, logInteraction } from '../lib/db.js';
import 'dotenv/config';

// Domain expiry agent: finds Dark businesses whose domain expired recently.
// A domain lapsing = website AND email down simultaneously. If we can reach
// them in that window we're solving a crisis before they've fully registered it.
// Flags these as 'expired' status and hot temperature for priority outreach.
// Runs daily. Safe to re-run — only touches businesses not yet flagged.

const EXPIRY_LOOKBACK_DAYS = 60; // domains expired in the last 60 days
const EXPIRY_LOOKAHEAD_DAYS = 7; // also catch domains expiring in the next 7 days (pre-empt)

export async function runDomainExpiryAgent() {
  const now = new Date();
  const lookbackDate = new Date(now - EXPIRY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const lookaheadDate = new Date(now.getTime() + EXPIRY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  // Recently lapsed: expired in last 60 days — site and email are down now
  const { data: lapsed } = await supabase
    .from('businesses')
    .select('id, name, domain, whois_expiry_date, whois_registrar, lead_temperature, website_status')
    .in('website_status', ['parked', 'broken', 'broken_dns', 'broken_server', 'coming_soon', 'seo_doorway'])
    .gte('whois_expiry_date', lookbackDate)
    .lt('whois_expiry_date', today)
    .neq('website_status', 'expired'); // don't re-process

  // Imminent expiry: expires in next 7 days — flag for early contact
  const { data: imminent } = await supabase
    .from('businesses')
    .select('id, name, domain, whois_expiry_date, whois_registrar, lead_temperature, website_status')
    .in('website_status', ['parked', 'broken', 'broken_dns', 'broken_server', 'coming_soon', 'seo_doorway'])
    .gte('whois_expiry_date', today)
    .lte('whois_expiry_date', lookaheadDate);

  const lapsedCount = (lapsed || []).length;
  const imminentCount = (imminent || []).length;

  if (!lapsedCount && !imminentCount) {
    console.log('Domain expiry: no recently lapsed or imminent expirations');
    return { lapsed: 0, imminent: 0 };
  }

  console.log(`\nDomain expiry: ${lapsedCount} recently lapsed, ${imminentCount} expiring soon`);

  // Process lapsed — maximum urgency
  for (const b of (lapsed || [])) {
    const daysSince = Math.floor((now - new Date(b.whois_expiry_date)) / (24 * 60 * 60 * 1000));
    console.log(`  [LAPSED ${daysSince}d ago] ${b.name} — ${b.domain} (${b.whois_registrar || 'unknown registrar'})`);

    await supabase.from('businesses').update({
      website_status:   'expired',
      lead_temperature: 'hot',
      pipeline_status:  'researched',
      is_prospect:      true,
    }).eq('id', b.id);

    await logInteraction(
      b.id, 'domain_lapsed', 'internal',
      `Domain expired ${daysSince} days ago (${b.whois_expiry_date}). Website and email likely down. Priority outreach candidate.`,
      null,
      { domain: b.domain, expiry_date: b.whois_expiry_date, registrar: b.whois_registrar, days_lapsed: daysSince }
    );
  }

  // Process imminent — flag but don't yet change website_status
  for (const b of (imminent || [])) {
    const daysUntil = Math.floor((new Date(b.whois_expiry_date) - now) / (24 * 60 * 60 * 1000));
    console.log(`  [EXPIRES in ${daysUntil}d] ${b.name} — ${b.domain} expires ${b.whois_expiry_date}`);

    await supabase.from('businesses').update({
      lead_temperature: 'hot',
    }).eq('id', b.id);

    await logInteraction(
      b.id, 'domain_expiry_imminent', 'internal',
      `Domain expires in ${daysUntil} days (${b.whois_expiry_date}). Pre-emptive outreach opportunity.`,
      null,
      { domain: b.domain, expiry_date: b.whois_expiry_date, registrar: b.whois_registrar, days_until: daysUntil }
    );
  }

  console.log(`\nDomain expiry complete: ${lapsedCount} flagged as expired, ${imminentCount} flagged as imminent\n`);
  return { lapsed: lapsedCount, imminent: imminentCount };
}
