#!/usr/bin/env node
// Builds sites with full super-enrichment: Serper (3 searches) + website scrape + Wayback Machine.
// Selects businesses with live websites to showcase maximum enrichment.
// Deploys to alreadydone.uk/preview/ with -super suffix for direct comparison.

import 'dotenv/config';
import { mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { supabase } from '../lib/db.js';
import { generateSite } from '../lib/claude.js';
import { generateSlug, injectClaimBanner } from '../lib/screenshot.js';
import { enrichBusinessForSiteBuild } from '../lib/serper-enricher.js';
import { alert } from '../lib/slack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = '/tmp/super-enriched-compare';
const PREVIEW_DIR = join(__dirname, '../sites/alreadydone.uk/preview');
const PREVIEW_BASE_URL = 'https://alreadydone.uk/preview';
const DEPLOY_SCRIPT = join(__dirname, 'deploy-site.sh');

mkdirSync(OUT_DIR, { recursive: true });

const SAMPLE_SIZE = parseInt(process.env.SAMPLE_SIZE || '5');

// Prefer businesses with live websites for maximum enrichment showcase
const { data: liveWebsite, error: e1 } = await supabase
  .from('businesses')
  .select('id, name, category, location, address, short_address, postcode, google_maps_uri, phone, email, google_rating, review_count, editorial_summary, opening_hours, attributes, google_reviews, photo_references, website_status, domain, whois_registered_date')
  .eq('pipeline_status', 'researched')
  .eq('website_status', 'live')
  .not('phone', 'is', null)
  .not('photo_references', 'is', null)
  .not('domain', 'is', null)
  .order('google_rating', { ascending: false, nullsFirst: false })
  .limit(SAMPLE_SIZE);

// Fall back to any researched businesses with photos if not enough with live sites
const { data: anyResearched, error: e2 } = await supabase
  .from('businesses')
  .select('id, name, category, location, address, short_address, postcode, google_maps_uri, phone, email, google_rating, review_count, editorial_summary, opening_hours, attributes, google_reviews, photo_references, website_status, domain, whois_registered_date')
  .eq('pipeline_status', 'researched')
  .not('phone', 'is', null)
  .not('photo_references', 'is', null)
  .order('google_rating', { ascending: false, nullsFirst: false })
  .limit(SAMPLE_SIZE);

if (e1 || e2) { console.error('DB error:', e1?.message || e2?.message); process.exit(1); }

// Merge: live-website businesses first, fill rest from any researched
const liveIds = new Set((liveWebsite || []).map(b => b.id));
const combined = [
  ...(liveWebsite || []),
  ...(anyResearched || []).filter(b => !liveIds.has(b.id)),
].slice(0, SAMPLE_SIZE);

if (!combined.length) { console.log('No researched businesses found'); process.exit(0); }

console.log(`\nSuper-enriched build for ${combined.length} businesses`);
console.log(`  (${(liveWebsite || []).length} with live websites — will include website scraping)`);
console.log(`Output: ${OUT_DIR}\n`);

for (const b of combined) {
  const slug = generateSlug(b.name, b.location);
  console.log(`\n── ${b.name} (${b.category}, ${b.location})`);
  console.log(`   website_status: ${b.website_status}${b.domain ? ` | domain: ${b.domain}` : ''}`);

  const commonFields = {
    name: b.name, category: b.category, location: b.location,
    address: b.short_address || b.address, postcode: b.postcode,
    google_maps_uri: b.google_maps_uri,
    phone: b.phone, email: b.email, slug,
    google_rating: b.google_rating, review_count: b.review_count,
    editorial_summary: b.editorial_summary, opening_hours: b.opening_hours,
    attributes: b.attributes, google_reviews: b.google_reviews,
    photo_references: b.photo_references,
  };

  // --- Super-enriched site ---
  console.log(`  Fetching super-enriched context...`);
  const ctx = await enrichBusinessForSiteBuild(b).catch(err => {
    console.error(`  Enrichment error: ${err.message}`);
    return null;
  });

  if (ctx) {
    const hints = [
      ctx.established ? `est. ${ctx.established}` : null,
      ctx.years_trading ? `${ctx.years_trading}yrs` : null,
      ctx.web_presence_since ? `web since ${ctx.web_presence_since}` : null,
      ctx.owner_name ? `owner: ${ctx.owner_name}` : null,
      ctx.accreditations?.length ? ctx.accreditations.slice(0, 2).join(', ') : null,
      ctx.areas_served ? `areas: ${ctx.areas_served.slice(0, 40)}` : null,
      ctx.site_text_excerpt ? `website scraped (${Math.round(ctx.site_text_excerpt.length / 5)} words)` : null,
      ctx.site_testimonials?.length ? `${ctx.site_testimonials.length} testimonials` : null,
      ctx.usps?.length ? `${ctx.usps.length} USPs` : null,
      ctx.brief ? 'synthesised ✓' : null,
    ].filter(Boolean);
    console.log(`  Context: ${hints.join(' | ') || 'snippets only'}`);
    if (ctx.brief?.one_liner) console.log(`  Brief: "${ctx.brief.one_liner}"`);
  } else {
    console.log(`  Context: none found`);
  }

  console.log(`  Building super-enriched site...`);
  const html = await generateSite({ ...commonFields, serper_context: ctx });
  writeFileSync(`${OUT_DIR}/${slug}-super.html`, html);
  const previewDir = `${PREVIEW_DIR}/${slug}-super`;
  mkdirSync(previewDir, { recursive: true });
  writeFileSync(`${previewDir}/index.html`, injectClaimBanner(html, b.name));
  console.log(`  Super: ${PREVIEW_BASE_URL}/${slug}-super/`);

  await sleep(70000);
}

console.log('\nDeploying previews to alreadydone.uk...');
try {
  execSync(`bash "${DEPLOY_SCRIPT}"`, { stdio: 'inherit', cwd: join(__dirname, '..') });
  console.log('  ✓ Deployed');
} catch (err) {
  console.error('  Deploy failed:', err.message);
}

const lines = combined.map(b => {
  const slug = generateSlug(b.name, b.location);
  const hasWebsite = b.website_status === 'live' ? ' (website scraped)' : '';
  return `• *${b.name}*${hasWebsite}\n  Super: ${PREVIEW_BASE_URL}/${slug}-super/`;
}).join('\n\n');

console.log(`\nDone. Preview at:\n  ${PREVIEW_BASE_URL}/`);
await alert('🚀 Super-enriched sites ready — Serper + website scrape + Wayback', lines).catch(() => {});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
