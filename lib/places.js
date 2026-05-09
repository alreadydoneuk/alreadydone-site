import 'dotenv/config';

const BASE_URL = 'https://places.googleapis.com/v1';

// All Basic + Advanced SKU fields — since websiteUri already triggers Advanced billing,
// every other Advanced field here costs nothing extra per request.
const FIELD_MASK = [
  // Basic — identity and location
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.addressComponents',
  'places.location',
  'places.googleMapsUri',
  'places.businessStatus',
  'places.types',
  'places.primaryType',
  'places.primaryTypeDisplayName',

  // Advanced — contact + web
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',

  // Advanced — quality signals
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.editorialSummary',

  // Advanced — opening hours
  'places.regularOpeningHours',

  // Advanced — photos (references only, not the images themselves)
  'places.photos',

  // Advanced — attributes (food/hospitality)
  'places.delivery',
  'places.dineIn',
  'places.takeout',
  'places.reservable',
  'places.servesBreakfast',
  'places.servesLunch',
  'places.servesDinner',
  'places.servesBrunch',
  'places.servesBeer',
  'places.servesWine',
  'places.servesCocktails',
  'places.servesDessert',
  'places.servesVegetarianFood',
  'places.menuForChildren',
  'places.outdoorSeating',
  'places.liveMusic',
  'places.allowsDogs',
  'places.curbsidePickup',

  // Advanced — accessibility
  'places.accessibilityOptions',

  // Preferred — real customer review text (used to seed site testimonials and services copy)
  'places.reviews',
].join(',');

// Returns { places, apiRequests } — apiRequests is the number of HTTP calls made
// so the caller can track against the daily budget accurately.
export async function searchPlaces(query, maxResults = 60) {
  const results = [];
  let pageToken = null;
  let page = 0;
  let apiRequests = 0;

  do {
    page++;
    apiRequests++;
    // Pagination requests must send ONLY pageToken — no other fields alongside it.
    // Google also requires ~2s before a fresh nextPageToken becomes valid.
    const body = pageToken
      ? { pageToken }
      : { textQuery: query, maxResultCount: 20, languageCode: 'en-GB' };

    const response = await fetch(`${BASE_URL}/places:searchText`, {
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Places API ${response.status}: ${err}`);
    }

    const data = await response.json();
    const places = data.places || [];
    results.push(...places);
    pageToken = data.nextPageToken || null;

    if (places.length === 0) break;
    if (pageToken) {
      process.stdout.write(` [p${page + 1}]`);
      await sleep(2000); // Google requires ~2s before the next page token is usable
    }
  } while (pageToken && results.length < maxResults);

  return { places: results.map(normalise).slice(0, maxResults), apiRequests };
}

function normalise(p) {
  // Extract structured opening hours
  let openingHours = null;
  if (p.regularOpeningHours?.periods) {
    openingHours = {
      periods: p.regularOpeningHours.periods,
      weekdayDescriptions: p.regularOpeningHours.weekdayDescriptions || [],
    };
  }

  // Photo references (not URLs — requires a separate fetch to resolve)
  const photoRefs = (p.photos || []).slice(0, 5).map(ph => ph.name);

  // Address components — extract postcode and town
  const components = p.addressComponents || [];
  const postcode = components.find(c => c.types?.includes('postal_code'))?.longText || null;
  const town = components.find(c => c.types?.includes('postal_town'))?.longText ||
               components.find(c => c.types?.includes('locality'))?.longText || null;

  // Food/hospitality attributes — only include truthy ones
  const attributes = {};
  const boolFields = [
    'delivery', 'dineIn', 'takeout', 'reservable', 'outdoorSeating',
    'liveMusic', 'allowsDogs', 'curbsidePickup',
    'servesBreakfast', 'servesLunch', 'servesDinner', 'servesBrunch',
    'servesBeer', 'servesWine', 'servesCocktails', 'servesDessert',
    'servesVegetarianFood', 'menuForChildren',
  ];
  for (const f of boolFields) {
    if (p[f] === true) attributes[f] = true;
  }
  if (p.accessibilityOptions?.wheelchairAccessibleEntrance) {
    attributes.wheelchairAccessibleEntrance = true;
  }

  // Google reviews — up to 5 most recent/helpful English-language reviews
  const reviews = (p.reviews || [])
    .filter(r => r.text?.languageCode === 'en' || !r.text?.languageCode)
    .slice(0, 5)
    .map(r => ({
      rating: r.rating || null,
      text: r.text?.text || null,
      author: r.authorAttribution?.displayName || null,
      time_ago: r.relativePublishTimeDescription || null,
    }))
    .filter(r => r.text && r.text.length > 10);

  return {
    place_id: p.id,
    name: p.displayName?.text || '',
    address: p.formattedAddress || '',
    short_address: p.shortFormattedAddress || null,
    postcode,
    town,
    phone: p.nationalPhoneNumber || null,
    phone_international: p.internationalPhoneNumber || null,
    website_uri: p.websiteUri || null,
    google_rating: p.rating || null,
    review_count: p.userRatingCount || null,
    price_level: parsePriceLevel(p.priceLevel),
    business_status: p.businessStatus || null,
    google_types: p.types || [],
    primary_type: p.primaryType || null,
    primary_type_label: p.primaryTypeDisplayName?.text || null,
    latitude: p.location?.latitude || null,
    longitude: p.location?.longitude || null,
    google_maps_uri: p.googleMapsUri || null,
    editorial_summary: p.editorialSummary?.text || null,
    opening_hours: openingHours,
    photo_references: photoRefs.length ? photoRefs : null,
    attributes: Object.keys(attributes).length ? attributes : null,
    google_reviews: reviews.length ? reviews : null,
  };
}

// Places API v1 returns priceLevel as a string enum, not a number
function parsePriceLevel(value) {
  const map = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  };
  if (typeof value === 'number') return value || null;
  return map[value] ?? null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
