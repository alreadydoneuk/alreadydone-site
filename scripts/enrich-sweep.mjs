// Full enrichment sweep — processes all prospects with no email that haven't been attempted yet.
// Covers Ghost (no domain) and Dark (broken/parked domain) cohorts.
// Stamps serper_attempted_at on every business regardless of outcome.
// Safe to re-run: skips any business already stamped.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { findEmailFromDirectories, lookupWhois } from '../lib/directory-finder.js';
import { isGenericEmailDomain } from '../lib/email-finder.js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { fetch: globalThis.fetch });

const DARK_STATUSES = new Set(['parked', 'broken', 'broken_dns', 'broken_server', 'coming_soon', 'seo_doorway']);
const SLEEP_MS = 1200; // ~50 req/min — well within Serper limits

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Load blocklist ────────────────────────────────────────────────────────────
const { data: blocklistRows } = await db.from('email_blocklist').select('email');
const blocklist = new Set((blocklistRows || []).map(r => r.email));
console.log(`Blocklist: ${blocklist.size} blocked emails\n`);

// ── Fetch all unenriched prospects ────────────────────────────────────────────
const { data: businesses, error } = await db
  .from('businesses')
  .select('id, name, category, location, phone, postcode, domain, website_status')
  .eq('is_prospect', true)
  .is('email', null)
  .is('serper_attempted_at', null)
  .order('website_status') // Dark first (have domain — higher hit rate)
  .order('phone', { ascending: false, nullsFirst: false }); // phone-having first within each group

if (error) { console.error('DB error:', error.message); process.exit(1); }
if (!businesses?.length) { console.log('Nothing to enrich — all prospects already attempted.'); process.exit(0); }

const total = businesses.length;
const darkCount  = businesses.filter(b => DARK_STATUSES.has(b.website_status)).length;
const ghostCount = total - darkCount;

console.log(`══════════════════════════════════════════════════`);
console.log(`  Enrichment sweep: ${total} businesses`);
console.log(`  Dark (has domain): ${darkCount}  Ghost (no domain): ${ghostCount}`);
console.log(`══════════════════════════════════════════════════\n`);

// ── Helpers ───────────────────────────────────────────────────────────────────
let found = 0, phoneOnly = 0, nothing = 0, i = 0;
const hits = [];
const startTime = Date.now();

function eta() {
  if (i === 0) return '—';
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = i / elapsed;
  const remaining = Math.round((total - i) / rate);
  const m = Math.floor(remaining / 60), s = remaining % 60;
  return `${m}m${s.toString().padStart(2,'0')}s`;
}

function progress() {
  const pct = Math.round(i / total * 100);
  const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  const rate = Math.round(found / i * 100) || 0;
  console.log(`\n[${bar}] ${pct}% — ${i}/${total} done | ${found} emails (${rate}%) | ETA ${eta()}\n`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
for (const b of businesses) {
  i++;
  const isDark = DARK_STATUSES.has(b.website_status);
  const tag = isDark ? '🌑 Dark' : '👻 Ghost';

  process.stdout.write(`[${i}/${total}] ${b.name} (${b.category}) ${tag} `);

  try {
    let whoisUpgrade = null;

    // WHOIS for Dark cohort — free metadata regardless of email outcome
    if (isDark && b.domain) {
      const whoisData = await lookupWhois(b.domain);
      if (whoisData) {
        const expiryDate = whoisData.expiry_date ? new Date(whoisData.expiry_date) : null;
        const recentlyExpired = expiryDate && expiryDate < new Date() &&
          expiryDate > new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

        whoisUpgrade = {
          whois_registrar:       whoisData.registrar || null,
          whois_registered_date: whoisData.registered_date || null,
          whois_expiry_date:     whoisData.expiry_date || null,
          whois_nameservers:     whoisData.nameservers || null,
        };
        if (recentlyExpired) whoisUpgrade.lead_temperature = 'hot';
      }
    }

    // Serper email search
    const result = await findEmailFromDirectories(b);

    if (result && blocklist.has(result.email)) {
      process.stdout.write(`→ blocklisted (${result.email}) — skipping\n`);
      await db.from('businesses').update({
        ...whoisUpgrade,
        serper_attempted_at: new Date().toISOString(),
      }).eq('id', b.id);
    } else if (result) {
      const emailType = isGenericEmailDomain(result.email) ? 'generic' : 'business';
      const temp      = result.confidence === 'high' ? 'hot' : 'warm';
      await db.from('businesses').update({
        ...whoisUpgrade,
        email:              result.email,
        email_type:         emailType,
        email_confidence:   result.confidence,
        email_source:       result.source,
        lead_temperature:   temp,
        outreach_route:     'email',
        serper_attempted_at: new Date().toISOString(),
      }).eq('id', b.id);
      hits.push(`  ${b.name} → ${result.email} [${result.confidence}]`);
      process.stdout.write(`→ ✓ ${result.email} [${result.confidence}]\n`);
      found++;
    } else {
      await db.from('businesses').update({
        ...whoisUpgrade,
        outreach_route:     b.phone ? 'phone' : null,
        serper_attempted_at: new Date().toISOString(),
      }).eq('id', b.id);
      if (b.phone) { process.stdout.write(`→ phone only\n`); phoneOnly++; }
      else          { process.stdout.write(`→ no route\n`);   nothing++;   }
    }
  } catch (err) {
    process.stdout.write(`→ error: ${err.message}\n`);
    await db.from('businesses').update({ serper_attempted_at: new Date().toISOString() }).eq('id', b.id).catch(() => {});
  }

  if (i % 25 === 0) progress();

  await sleep(SLEEP_MS);
}

// ── Final summary ─────────────────────────────────────────────────────────────
const elapsed = Math.round((Date.now() - startTime) / 1000);
const em = Math.floor(elapsed / 60), es = elapsed % 60;

console.log(`\n${'═'.repeat(50)}`);
console.log(`SWEEP COMPLETE — ${total} businesses in ${em}m${es.toString().padStart(2,'0')}s`);
console.log(`  Emails found:  ${found} (${Math.round(found/total*100)}%)`);
console.log(`  Phone only:    ${phoneOnly}`);
console.log(`  No route:      ${nothing}`);
console.log(`\nEmails found:`);
hits.forEach(h => console.log(h));
