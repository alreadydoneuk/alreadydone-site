import { generateSite } from '../lib/claude.js';
import { screenshotSite, generateSlug } from '../lib/screenshot.js';
import { supabase } from '../lib/db.js';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(__dirname, 'deploy-site.sh');
const PREVIEW_BASE_URL = 'https://alreadydone.uk/preview';

// 5 businesses across data richness spectrum — score 11 down to 2
const TEST_IDS = [
  'bd890046-fd01-4a9e-8813-db444e9e0d21', // Angela's Squiggly Faces — face painter, score 11 (5 reviews fetched, photos, email)
  'ef024019-4e0e-45db-8b9e-6712030eccba', // Stuart Martin Framing — picture framer, score 7 (photos, email, no fetched reviews)
  'f6d0507f-eba2-47bb-9d8e-f6e60c072bb6', // Broadway Chauffeur Service — chauffeur, score 5 (photos, 2 reviews, no email)
  '7da074e5-c0f2-4597-9ee4-8a9d0224e985', // Waverley Toastmasters — toastmaster, score 4 (photos, no email)
  'cd252bc9-c220-497f-ba9e-574aafdfa040', // S O'Rourke Window Cleaning — gutter cleaner, score 2 (no photos, no email, 1 review)
];

console.log(`=== Site Builder Test — ${TEST_IDS.length} businesses ===\n`);

let totalInputTokens = 0;
let totalOutputTokens = 0;

for (let i = 0; i < TEST_IDS.length; i++) {
  const id = TEST_IDS[i];
  const { data: business, error } = await supabase
    .from('businesses')
    .select('id, name, category, location, address, short_address, postcode, google_maps_uri, phone, email, google_rating, review_count, editorial_summary, opening_hours, attributes, google_reviews, photo_references, website_status, domain')
    .eq('id', id)
    .single();

  if (error || !business) { console.error('Not found:', id); continue; }

  console.log(`[${i + 1}/${TEST_IDS.length}] ${business.name}`);
  console.log(`  Category: ${business.category} | Status: ${business.website_status}`);
  if (business.google_rating) console.log(`  Google: ${business.google_rating}/5 (${business.review_count} reviews)`);
  if (!business.email) console.log(`  ⚠ No email — site will be built but cannot be sold via email outreach`);

  const slug = generateSlug(business.name, business.location);
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
  });

  const { htmlPath, screenshotPath } = await screenshotSite(slug, html, business.name);
  const previewUrl = `${PREVIEW_BASE_URL}/${slug}`;

  await supabase.from('businesses').update({
    site_slug: slug,
    template_html: html,
    template_screenshot: screenshotPath,
    preview_url: previewUrl,
    pipeline_status: 'template_built',
  }).eq('id', id);

  console.log(`  Preview: ${previewUrl}`);
  console.log(`  ✓ Done\n`);

  if (i < TEST_IDS.length - 1) {
    console.log('  (waiting 70s...)\n');
    await new Promise(r => setTimeout(r, 70000));
  }
}

console.log('Deploying all preview sites to alreadydone.uk...');
execSync(`bash "${DEPLOY_SCRIPT}"`, { stdio: 'inherit' });
console.log('\nAll done.');
