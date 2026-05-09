import dns from 'dns/promises';
import { getNextQueueItem, markQueueRunning, markQueueComplete, upsertDirectoryListing, logInteraction } from '../lib/db.js';
import { searchPlaces } from '../lib/places.js';
import { checkDomain, extractDomain, isQualifiedLead, leadTier, leadTemperature, isKeywordStuffedDomain } from '../lib/parked.js';
import { isChain } from '../lib/chains.js';
import 'dotenv/config';

const MAX_RESULTS = parseInt(process.env.MAX_RESULTS_PER_QUERY || '60');

// Categories where the business would build their own site — exclude from all prospect flows
const WEB_AGENCY_CATEGORIES = new Set([
  'web developer', 'web designer', 'website designer', 'seo consultant',
  'it consultant', 'it support', 'app developer', 'software company',
  'digital marketing agency', 'marketing consultant',
  'internet marketing service', 'graphic designer',
]);

// Social platforms — a Facebook/Instagram URL means no real website
const SOCIAL_DOMAINS = ['facebook.com', 'instagram.com', 'twitter.com', 'linkedin.com', 'tiktok.com'];

export async function runResearchAgent(targetArea = null) {
  const item = await getNextQueueItem(targetArea);
  if (!item) {
    console.log(targetArea ? `No pending items for: ${targetArea}` : 'Queue empty');
    return { processed: 0 };
  }

  console.log(`\nResearching: ${item.category} in ${item.location}`);
  await markQueueRunning(item.id);

  let places, apiRequests;
  try {
    ({ places, apiRequests } = await searchPlaces(`${item.category} in ${item.location}`, MAX_RESULTS));
  } catch (err) {
    console.error(`  Places API error: ${err.message}`);
    return { processed: 0, apiRequests: 1 };
  }

  console.log(`  Found ${places.length} results (${apiRequests} API call${apiRequests !== 1 ? 's' : ''})`);

  let saved = 0, prospects = 0, skipped = 0;

  for (const place of places) {
    try {
      const result = await processPlace(place, item.category, item.location);
      if (result === 'skipped') { skipped++; continue; }
      saved++;
      if (result?.is_prospect) prospects++;
    } catch (err) {
      console.error(`  Error processing ${place.name}: ${err.message}`);
    }
    await sleep(300);
  }

  await markQueueComplete(item.id, saved);
  console.log(`  Saved ${saved} | Prospects ${prospects} | Skipped ${skipped}\n`);
  return { processed: places.length, saved, prospects, apiRequests };
}

async function processPlace(place, category, location) {
  if (place.business_status === 'CLOSED_PERMANENTLY') {
    process.stdout.write(`  [closed      ] ${place.name}\n`);
    return 'skipped';
  }

  if (isChain(place)) {
    process.stdout.write(`  [chain-skip  ] ${place.name}\n`);
    return 'skipped';
  }

  // Skip web/digital agencies — they'd build their own site
  if (WEB_AGENCY_CATEGORIES.has((category || '').toLowerCase())) {
    process.stdout.write(`  [web-agency  ] ${place.name}\n`);
    return 'skipped';
  }

  let websiteStatus = null;
  let isProspect = false;
  let tier = null;
  let temperature = null;
  let domain = null;
  let hasMx = false;

  if (place.website_uri) {
    // Check if the "website" is actually just a social media page
    const isSocialUrl = SOCIAL_DOMAINS.some(s => place.website_uri.includes(s));

    if (isSocialUrl) {
      // Treat like no website — they have no domain of their own
      websiteStatus = 'social';
      isProspect = true;
      tier = 3;
      temperature = 'cold';
    } else {
      domain = extractDomain(place.website_uri);

      if (domain && isKeywordStuffedDomain(domain)) {
        websiteStatus = 'seo_doorway';
        isProspect = true;
        hasMx = await checkMx(domain);
        tier = leadTier(websiteStatus);
        temperature = leadTemperature(websiteStatus, true, hasMx);
      } else if (domain) {
        websiteStatus = await checkDomain(place.website_uri);
        isProspect = isQualifiedLead(websiteStatus);

        if (isProspect) {
          hasMx = await checkMx(domain);
          tier = leadTier(websiteStatus);
          temperature = leadTemperature(websiteStatus, true, hasMx);
        }
      }
    }
  } else {
    websiteStatus = 'none';
    isProspect = true;
    tier = 3;
    temperature = 'cold';
  }

  const flag = isProspect ? ` ★ ${temperature}` : '';
  const label = (websiteStatus || 'unknown').padEnd(13);
  console.log(`  [${label}] ${place.name}${domain ? ` — ${domain}` : ''}${flag}`);

  const record = {
    place_id: place.place_id,
    name: place.name,
    category,
    source_category: category,
    location,
    address: place.address,
    short_address: place.short_address,
    postcode: place.postcode,
    town: place.town || location,
    phone: place.phone,
    phone_international: place.phone_international,
    domain,
    google_rating: place.google_rating,
    review_count: place.review_count,
    price_level: place.price_level,
    business_status: place.business_status,
    google_types: place.google_types,
    primary_type: place.primary_type,
    primary_type_label: place.primary_type_label,
    latitude: place.latitude,
    longitude: place.longitude,
    google_maps_uri: place.google_maps_uri,
    editorial_summary: place.editorial_summary,
    opening_hours: place.opening_hours,
    photo_references: place.photo_references,
    attributes: place.attributes,
    google_reviews: place.google_reviews,
    website_status: websiteStatus,
    is_prospect: isProspect,
    tier,
    lead_temperature: temperature,
    domain_has_mx: hasMx || null,
    pipeline_status: isProspect ? 'researched' : null,
  };

  const savedRecord = await upsertDirectoryListing(record);

  if (isProspect) {
    await logInteraction(
      savedRecord.id,
      'research',
      'internal',
      `Found via Places API. Status: ${websiteStatus}. Tier: ${tier}. Temperature: ${temperature}.${hasMx ? ' Has MX.' : ''}`,
      JSON.stringify({ place_id: place.place_id, website_uri: place.website_uri })
    );
  }

  return savedRecord;
}

async function checkMx(domain) {
  try {
    const bare = domain.replace(/^www\./, '');
    const records = await dns.resolveMx(bare);
    return records.length > 0;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
