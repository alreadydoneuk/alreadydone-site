import { getBusinessesByStatus, updateBusiness, logInteraction } from '../lib/db.js';
import { generateSite } from '../lib/claude.js';
import { screenshotSite, generateSlug } from '../lib/screenshot.js';
import { alert } from '../lib/slack.js';
import { enrichBusinessForSiteBuild } from '../lib/serper-enricher.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import 'dotenv/config';

// ── Pre-build guards ────────────────────────────────────────────────────────

const GENERIC_EMAIL_DOMAINS = ['gmail','yahoo','hotmail','icloud','outlook','live','mail','ymail','btinternet','sky','virginmedia'];
const isGenericEmail = email => GENERIC_EMAIL_DOMAINS.some(d => email.toLowerCase().includes('@' + d + '.'));

// Keywords that signal a mismatch when found in the email domain but not the business name/category
const EMAIL_MISMATCH_KEYWORDS = ['photography','photo','landscap','webdesign','web-design','traffic-update','andynewbold'];

function validateEmail(email) {
  if (!email) return { ok: false, reason: 'no_email' };
  if (/u00[0-9a-f]{2}|&[a-z]+;|%[0-9a-f]{2}/i.test(email)) return { ok: false, reason: 'html_entity' };
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email)) return { ok: false, reason: 'invalid_format' };
  if (/\.(co\.uk|com|net|org)[a-zA-Z]+/.test(email)) return { ok: false, reason: 'malformed_tld' };
  return { ok: true };
}

function detectEmailMismatch(email, name, category) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  const context = (name + ' ' + category).toLowerCase();
  const kw = EMAIL_MISMATCH_KEYWORDS.find(k => domain.includes(k) && !context.includes(k));
  return kw || null;
}

// Parked/coming_soon with a custom email — never build speculatively.
// Always defer to expiry_watch so WHOIS is re-checked on the day before building.
const EXPIRY_WATCH_STATUSES = ['parked', 'coming_soon'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(__dirname, '..', 'sites');

const TARGET = parseInt(process.env.SITE_BUILD_BATCH_SIZE || '40');
const PREVIEW_BASE_URL = 'https://alreadydone.uk/preview';

export async function runSiteBuilderAgent() {
  const businesses = await getBusinessesByStatus('researched');

  if (businesses.length === 0) {
    console.log('No researched businesses to build sites for');
    return { built: 0 };
  }

  // Must have at least one outreach route — email is required to sell the site.
  // Phone-only businesses can't receive the preview link or a purchase link.
  const contactable = businesses.filter(b => b.email);
  const noEmail = businesses.length - contactable.length;
  if (noEmail > 0) {
    console.log(`  Skipped ${noEmail} businesses with no email address`);
  }

  if (contactable.length === 0) {
    console.log('No contactable businesses to build sites for');
    return { built: 0 };
  }

  console.log(`\nTarget: ${TARGET} sites — pool: ${contactable.length} contactable`);

  let built = 0;
  let attempted = 0;
  const builtBusinesses = [];

  for (const business of contactable) {
    if (built >= TARGET) break;
    attempted++;
    const prevBuilt = built;
    try {
      await buildSiteForBusiness(business);
      built++;
    } catch (err) {
      // Skip gracefully if business was deleted mid-run (e.g. by reverify script)
      if (err?.code === 'PGRST116') {
        console.log(`  Skipped ${business.name} — no longer in database`);
        continue;
      }
      console.error(`  Failed for ${business.name}: ${err.message}`);
      await logInteraction(business.id, 'error', 'internal', `Site build failed: ${err.message}`, err.stack);
    }
    // Only add to the list if the build actually succeeded
    if (built > prevBuilt) builtBusinesses.push(business);

    // Only sleep if we're going to build another — skip the wait after the last one
    if (built < TARGET && attempted < contactable.length) {
      // One site per minute — Tier 1 output token limit (~8k/min, one site ~5-6k tokens)
      await sleep(70000);
    }
  }

  console.log(`\nBuilt ${built} sites (${attempted} attempted, ${attempted - built} skipped/failed)\n`);

  if (built > 0) {
    const lines = builtBusinesses.map(b =>
      `• ${b.name} (${b.category}, ${b.location}) — ${PREVIEW_BASE_URL}/${generateSlug(b.name, b.location)}`
    ).join('\n');
    await alert(`🏗️ ${built} preview site${built > 1 ? 's' : ''} built`, lines).catch(() => {});
  }

  return { built };
}

async function buildSiteForBusiness(business) {
  console.log(`\n  Building: ${business.name} (${business.category}, ${business.location})`);

  // ── Guard 1: email validation ───────────────────────────────────────────
  const emailCheck = validateEmail(business.email);
  if (!emailCheck.ok) {
    console.log(`    ✗ Skipping — bad email (${emailCheck.reason}): ${business.email || 'none'}`);
    await updateBusiness(business.id, { email: null, pipeline_status: 'researched' });
    await logInteraction(business.id, 'skip', 'internal', `Skipped build — invalid email (${emailCheck.reason}): ${business.email || 'none'}`);
    return;
  }

  // ── Guard 2: email domain mismatch ─────────────────────────────────────
  const mismatch = detectEmailMismatch(business.email, business.name, business.category);
  if (mismatch) {
    console.log(`    ✗ Skipping — email domain mismatch (${mismatch}): ${business.email}`);
    await updateBusiness(business.id, { email: null, pipeline_status: 'researched' });
    await logInteraction(business.id, 'skip', 'internal', `Skipped build — email domain mismatch [${mismatch}]: ${business.email}`);
    return;
  }

  // ── Guard 3: expiry watch — never build parked/coming_soon with custom email speculatively.
  // The expiry-watch agent re-checks WHOIS daily and moves to researched when the domain
  // is genuinely approaching expiry. Site gets built that same night, emailed next morning.
  if (EXPIRY_WATCH_STATUSES.includes(business.website_status) && !isGenericEmail(business.email)) {
    const daysUntilExpiry = business.whois_expiry_date
      ? Math.round((new Date(business.whois_expiry_date) - new Date()) / (1000 * 60 * 60 * 24))
      : null;
    const expiryNote = daysUntilExpiry !== null ? ` (${daysUntilExpiry}d, ${business.whois_expiry_date})` : ' (no expiry date)';
    console.log(`    ⏳ Expiry watch — ${business.website_status} domain${expiryNote}, deferring until WHOIS re-check confirms due`);
    await updateBusiness(business.id, { pipeline_status: 'expiry_watch' });
    await logInteraction(
      business.id, 'expiry_watch', 'internal',
      `Deferred build — ${business.website_status} domain, expiry: ${business.whois_expiry_date || 'unknown'}${daysUntilExpiry !== null ? ` (${daysUntilExpiry} days)` : ''}. Will build when expiry-watch agent confirms domain is due.`,
      null,
      { website_status: business.website_status, whois_expiry_date: business.whois_expiry_date, days_until_expiry: daysUntilExpiry }
    );
    return;
  }

  const slug = generateSlug(business.name, business.location);

  const serperContext = await enrichBusinessForSiteBuild(business).catch(() => null);

  // Pre-build website check: enrichment may discover a working website we missed at research time.
  if (serperContext?.discovered_website) {
    const { url } = serperContext.discovered_website;
    console.log(`    ⚠️  Website discovered at enrichment: ${url} — excluding`);
    await updateBusiness(business.id, {
      website_status: 'live',
      is_prospect: false,
      pipeline_status: 'excluded',
    });
    await logInteraction(
      business.id, 'skip', 'internal',
      `Excluded at pre-build check — website found: ${url}`, null,
      serperContext.discovered_website,
    );
    return; // caller handles the missing return value gracefully (built stays unchanged)
  }

  if (serperContext) {
    const hints = [
      serperContext.established ? `est. ${serperContext.established}` : null,
      serperContext.years_trading ? `${serperContext.years_trading}yrs` : null,
      serperContext.web_presence_since ? `web since ${serperContext.web_presence_since}` : null,
      serperContext.owner_name ? `owner: ${serperContext.owner_name}` : null,
      serperContext.accreditations?.length ? serperContext.accreditations.slice(0, 2).join(', ') : null,
      serperContext.site_text_excerpt ? 'website scraped ✓' : null,
      serperContext.brief ? 'synthesised ✓' : null,
    ].filter(Boolean);
    console.log(`    [enrichment] ${hints.join(' | ') || 'snippets only'}`);
    if (serperContext.brief?.one_liner) console.log(`    [brief] "${serperContext.brief.one_liner}"`);
  } else {
    console.log(`    [enrichment] no context found`);
  }

  const html = await generateSite({
    name: business.name,
    category: business.category,
    location: business.location,
    address: business.short_address || business.address,
    postcode: business.postcode,
    google_maps_uri: business.google_maps_uri,
    phone: business.phone,
    email: business.email,
    slug,
    google_rating: business.google_rating,
    review_count: business.review_count,
    editorial_summary: business.editorial_summary,
    opening_hours: business.opening_hours,
    attributes: business.attributes,
    google_reviews: business.google_reviews,
    photo_references: business.photo_references,
    serper_context: serperContext,
  });

  console.log(`    Generated HTML (${html.length} chars)`);

  const { htmlPath, screenshotPath } = await screenshotSite(slug, html, business.name);
  console.log(`    Screenshot saved: ${screenshotPath}`);

  const previewUrl = `${PREVIEW_BASE_URL}/${slug}`;

  await updateBusiness(business.id, {
    site_slug: slug,
    template_html: html,
    template_screenshot: screenshotPath,
    preview_url: previewUrl,
    pipeline_status: 'template_built',
  });

  await logInteraction(
    business.id,
    'site_built',
    'internal',
    `Template site generated. Preview: ${previewUrl}`,
    null,
    { slug, htmlPath, screenshotPath, previewUrl }
  );

  console.log(`    ✓ Done: ${business.name} → ${previewUrl}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
