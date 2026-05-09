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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(__dirname, '..', 'sites');

const BATCH_SIZE = parseInt(process.env.SITE_BUILD_BATCH_SIZE || '5');
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
  const skipped = businesses.length - contactable.length;
  if (skipped > 0) {
    console.log(`  Skipped ${skipped} businesses with no email address`);
  }

  if (contactable.length === 0) {
    console.log('No contactable businesses to build sites for');
    return { built: 0 };
  }

  const batch = contactable.slice(0, BATCH_SIZE);
  console.log(`\nBuilding sites for ${batch.length} businesses`);

  let built = 0;

  for (const business of batch) {
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

    // One site per minute — Tier 1 output token limit (~8k/min, one site ~5-6k tokens)
    await sleep(70000);
  }

  console.log(`\nBuilt ${built}/${batch.length} sites\n`);

  if (built > 0) {
    const lines = batch.slice(0, built).map(b =>
      `• ${b.name} (${b.category}, ${b.location}) — ${PREVIEW_BASE_URL}/${generateSlug(b.name, b.location)}`
    ).join('\n');
    await alert(`🏗️ ${built} preview site${built > 1 ? 's' : ''} built`, lines).catch(() => {});
  }

  return { built };
}

async function buildSiteForBusiness(business) {
  console.log(`\n  Building: ${business.name} (${business.category}, ${business.location})`);

  const slug = generateSlug(business.name, business.location);

  const serperContext = await enrichBusinessForSiteBuild(business).catch(() => null);
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
