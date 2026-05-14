// Audit every stored email in the DB against current validation rules.
// Clears bad emails (NHS/gov/ac institutional, placeholder names, careers@/support@/customerservice@,
// domain mismatches, non-UK TLDs) so businesses re-enter enrichment cleanly.
import { supabase } from '../lib/db.js';
import { isGenericEmailDomain } from '../lib/email-finder.js';
import { checkDomain } from '../lib/parked.js';

// ── Validation rules (mirrors enrichment-agent rejectEmail + extras) ──────────

const PLACEHOLDER_PATTERNS = [
  /^your@/, /^test@/, /^example@/, /^noreply@/, /^no-reply@/,
  /^email@/, /^info@info/, /^admin@admin/,
  /^jane\.doe@/, /^john\.doe@/, /^beatrice\.doe@/, /^john\.smith@/,
  /\.doe@/, // any firstname.doe@
  /^customerservice@/, /^customercare@/, /^careers@/, /^jobs@/, /^recruitment@/,
  /^support@(?!.*\.co\.uk)/, // support@ on non-UK domains only
  /u00[0-9a-f]{2}/i,  // HTML-encoded chars (u002f = /, scraped from directory profile URLs)
];
const isPlaceholder = e => PLACEHOLDER_PATTERNS.some(p => p.test(e.toLowerCase()));

const INSTITUTIONAL = [/@nhs\.(net|scot|uk)$/i, /@.*\.gov\.uk$/i, /@.*\.ac\.uk$/i];
const isInstitutional = e => INSTITUTIONAL.some(p => p.test(e));

// Non-UK international TLDs that indicate the email is from a foreign business
const FOREIGN_TLD = /\.(co\.nz|co\.za|com\.au|co\.in|co\.za|nz|au|ca|us|ie)$/i;
const isForeignTld = e => {
  const domain = e.split('@')[1] || '';
  return FOREIGN_TLD.test(domain);
};

// Known third-party platform domains — not the business owner's email
const PLATFORM_DOMAINS = [
  'alivenetwork.com', 'gigsalad.com', 'bark.com', 'yell.com',
  'checkatrade.com', 'mybuilder.com', 'ratedpeople.com', 'treatwell.co',
  'poyst.com', 'realpeoplemedia.co.uk',
];
const isPlatform = e => {
  const domain = (e.split('@')[1] || '').toLowerCase();
  return PLATFORM_DOMAINS.some(p => domain.includes(p));
};

// HTML-encoded characters in the local part
const isEncoded = e => /u00[0-9a-f]{2}|&[a-z]+;|%[0-9a-f]{2}/i.test(e.split('@')[0]);

const NAME_NOISE = new Set(['the','and','of','in','at','for','ltd','limited','llp','llc','plc','inc','co','services','solutions','group','uk','scotland','edinburgh']);

function hasDomainMismatch(email, name, category) {
  if (isGenericEmailDomain(email)) return false;
  const domain = (email.split('@')[1] || '').replace(/\.(co\.uk|com|net|org|uk|biz|info|trade|scot)$/, '').toLowerCase();
  const nameWords = (name + ' ' + (category||''))
    .toLowerCase().split(/[\s&\-_.,()\/]+/)
    .filter(w => w.length >= 4 && !NAME_NOISE.has(w));
  if (!nameWords.length) return false;
  const hasOverlap = nameWords.some(w => {
    if (domain.includes(w)) return true;
    if (w.length >= 7 && domain.includes(w.slice(0, 5))) return true;
    return false;
  });
  return !hasOverlap;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('=== Email Cleanup Audit ===\n');

const { data: businesses } = await supabase
  .from('businesses')
  .select('id, name, category, email, email_type, pipeline_status, website_status')
  .not('email', 'is', null)
  .not('pipeline_status', 'eq', 'emailed')   // don't touch already-sent
  .not('pipeline_status', 'eq', 'excluded')
  .order('created_at', { ascending: false });

if (!businesses?.length) { console.log('No emails to audit.'); process.exit(0); }
console.log(`Auditing ${businesses.length} stored emails...\n`);

let cleared = 0, ok = 0;

for (const b of businesses) {
  const email = b.email;
  let reason = null;

  if (isPlaceholder(email))                            reason = 'placeholder';
  else if (isInstitutional(email))                     reason = 'institutional';
  else if (isEncoded(email))                           reason = 'encoded_char';
  else if (isPlatform(email))                          reason = 'platform_email';
  else if (isForeignTld(email))                        reason = 'foreign_tld';
  else if (!isGenericEmailDomain(email) && hasDomainMismatch(email, b.name, b.category))
                                                       reason = 'domain_mismatch';

  if (reason) {
    console.log(`  ✗ [${reason.padEnd(18)}] ${b.name} — ${email}`);
    await supabase.from('businesses').update({
      email:               null,
      email_type:          null,
      email_confidence:    null,
      email_source:        null,
      serper_attempted_at: null,    // allow re-enrichment
      pipeline_status:     b.pipeline_status === 'template_built' ? 'template_built' : 'researched',
    }).eq('id', b.id);
    await supabase.from('interactions').insert({
      business_id:     b.id,
      type:            'skip',
      direction:       'internal',
      content_summary: `Email cleared by cleanup audit (${reason}): ${email}`,
      metadata:        { email, reason },
    });
    cleared++;
  } else {
    ok++;
  }
}

console.log(`\nDone: ${cleared} emails cleared, ${ok} passed validation.\n`);
