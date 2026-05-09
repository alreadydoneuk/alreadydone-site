#!/usr/bin/env node
// Builds 5 sites without Serper, then the same 5 with Serper enrichment.
// Outputs to /tmp/serper-compare/ AND deploys to alreadydone.uk/preview/ for review.
// Does NOT update the database or trigger outreach.

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
const OUT_DIR = '/tmp/serper-compare';
const PREVIEW_DIR = join(__dirname, '../sites/alreadydone.uk/preview');
const PREVIEW_BASE_URL = 'https://alreadydone.uk/preview';
const DEPLOY_SCRIPT = join(__dirname, 'deploy-site.sh');

mkdirSync(OUT_DIR, { recursive: true });

const SAMPLE_SIZE = 5;

const { data: businesses, error } = await supabase
  .from('businesses')
  .select('id, name, category, location, address, short_address, postcode, google_maps_uri, phone, email, google_rating, review_count, editorial_summary, opening_hours, attributes, google_reviews, photo_references, website_status, domain, whois_registered_date')
  .eq('pipeline_status', 'researched')
  .not('phone', 'is', null)
  .not('photo_references', 'is', null)
  .order('google_rating', { ascending: false, nullsFirst: false })
  .limit(SAMPLE_SIZE);

if (error) { console.error('DB error:', error.message); process.exit(1); }
if (!businesses?.length) { console.log('No researched businesses found'); process.exit(0); }

console.log(`\nComparing ${businesses.length} businesses with and without Serper enrichment`);
console.log(`Output: ${OUT_DIR}\n`);

for (const b of businesses) {
  const slug = generateSlug(b.name, b.location);
  console.log(`\n── ${b.name} (${b.category}, ${b.location})`);

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

  // --- Plain site (no Serper) ---
  console.log(`  Building plain site...`);
  const plainHtml = await generateSite({ ...commonFields, serper_context: null });
  writeFileSync(`${OUT_DIR}/${slug}-plain.html`, plainHtml);
  const plainPreviewDir = `${PREVIEW_DIR}/${slug}-plain`;
  mkdirSync(plainPreviewDir, { recursive: true });
  writeFileSync(`${plainPreviewDir}/index.html`, injectClaimBanner(plainHtml, b.name));
  console.log(`  Plain: ${PREVIEW_BASE_URL}/${slug}-plain/`);

  // Rate limit pause between Claude calls
  await sleep(70000);

  // --- Enriched site (with Serper) ---
  console.log(`  Fetching Serper context...`);
  const ctx = await enrichBusinessForSiteBuild(b).catch(() => null);
  if (ctx) {
    const hints = [
      ctx.established ? `est. ${ctx.established}` : null,
      ctx.accreditations?.length ? ctx.accreditations.join(', ') : null,
      ctx.areas_served || null,
    ].filter(Boolean);
    console.log(`  Serper: ${hints.join(' | ') || 'snippets only'}`);
  } else {
    console.log(`  Serper: no context found`);
  }

  console.log(`  Building enriched site...`);
  const enrichedHtml = await generateSite({ ...commonFields, serper_context: ctx });
  writeFileSync(`${OUT_DIR}/${slug}-enriched.html`, enrichedHtml);
  const enrichedPreviewDir = `${PREVIEW_DIR}/${slug}-enriched`;
  mkdirSync(enrichedPreviewDir, { recursive: true });
  writeFileSync(`${enrichedPreviewDir}/index.html`, injectClaimBanner(enrichedHtml, b.name));
  console.log(`  Enriched: ${PREVIEW_BASE_URL}/${slug}-enriched/`);

  await sleep(70000);
}

// Deploy all preview files to alreadydone.uk
console.log('\nDeploying previews to alreadydone.uk...');
try {
  execSync(`bash "${DEPLOY_SCRIPT}"`, { stdio: 'inherit', cwd: join(__dirname, '..') });
  console.log('  ✓ Deployed');
} catch (err) {
  console.error('  Deploy failed:', err.message);
}

const lines = businesses.map(b => {
  const slug = generateSlug(b.name, b.location);
  return `• *${b.name}*\n  Plain:    ${PREVIEW_BASE_URL}/${slug}-plain/\n  Enriched: ${PREVIEW_BASE_URL}/${slug}-enriched/`;
}).join('\n\n');

console.log(`\nDone. Preview at:\n  ${PREVIEW_BASE_URL}/`);
await alert('🔬 Serper comparison ready — review plain vs enriched', lines).catch(() => {});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
