import 'dotenv/config';

const PEXELS_KEY = process.env.PEXELS_API_KEY;
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const PEXELS_BASE = 'https://api.pexels.com/v1/search';
const PLACES_PHOTO_BASE = 'https://places.googleapis.com/v1';

// Sector → Pexels search terms (fallback only — used when no Google photos available)
const SECTOR_TERMS = {
  emergency_trades:  ['plumber emergency repair', 'electrician working', 'locksmith'],
  standard_trades:   ['builder construction', 'roofer roofing', 'home renovation interior'],
  food_hospitality:  ['cafe interior cosy', 'restaurant food plating', 'bakery fresh bread'],
  wellness:          ['massage therapy calm', 'physiotherapy treatment', 'wellness studio'],
  beauty:            ['hair salon styling', 'beauty salon treatment', 'nail art professional'],
  creative:          ['photographer studio', 'graphic design creative', 'artist workshop'],
  professional:      ['business meeting professional', 'office consultant', 'accountant desk'],
  automotive:        ['car mechanic garage', 'vehicle service workshop', 'auto repair'],
  childcare:         ['childcare nursery children', 'playgroup learning', 'childminder caring'],
  driving:           ['driving lesson instructor', 'learner driver car', 'road driving'],
  events:            ['wedding flowers bouquet', 'event decoration venue', 'floral arrangement'],
  local_lifestyle:   ['dog grooming professional', 'cleaning service home', 'garden landscaping'],
  general:           ['small business professional', 'local service team', 'business owner'],
};

const PROFILE_TO_KEY = {
  'Emergency Trades - Call Now':          'emergency_trades',
  'Local Trades - Get a Quote':           'standard_trades',
  'Food & Hospitality - Appetite Led':    'food_hospitality',
  'Wellness - Relationship First':        'wellness',
  'Beauty & Grooming - Book Now':         'beauty',
  'Creative Portfolio - Work Led':        'creative',
  'Professional Services - Trust First':  'professional',
  'Automotive - Book Your Car In':        'automotive',
  'Childcare & Education - Safe and Warm':'childcare',
  'Driving Instructor - Book a Lesson':   'driving',
  'Events & Creative - Enquire Now':      'events',
  'Local Service - Reliable and Friendly':'local_lifestyle',
  'Local Business - Get in Touch':        'general',
};

// Fetch actual business photos from Google Places using stored photo_references.
// Returns up to `count` images with lh3.googleusercontent.com URLs.
async function fetchGooglePlacesPhotos(photoReferences, count = 2) {
  if (!PLACES_KEY || !photoReferences?.length) return null;

  const results = [];
  for (const ref of photoReferences.slice(0, count + 2)) {
    if (results.length >= count) break;
    try {
      const url = `${PLACES_PHOTO_BASE}/${ref}/media?maxHeightPx=1200&skipHttpRedirect=true&key=${PLACES_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.photoUri) continue;
      results.push({
        url: data.photoUri,
        thumb: data.photoUri,
        alt: 'Business photo',
        credit: null,
      });
    } catch {
      continue;
    }
  }

  return results.length ? results : null;
}

async function fetchPexelsImages(sectorName, category, count = 2) {
  if (!PEXELS_KEY) return null;

  const key = PROFILE_TO_KEY[sectorName] || 'general';
  const sectorTerms = SECTOR_TERMS[key] || SECTOR_TERMS.general;

  // Try the specific category first (e.g. "jewellery repair shop"), then sector fallbacks
  const terms = category ? [`${category} shop UK`, ...sectorTerms] : sectorTerms;

  for (const term of terms) {
    try {
      const res = await fetch(
        `${PEXELS_BASE}?query=${encodeURIComponent(term)}&per_page=${count + 2}&orientation=landscape`,
        { headers: { Authorization: PEXELS_KEY }, signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) continue;
      const json = await res.json();
      const photos = (json.photos || []).slice(0, count);
      if (!photos.length) continue;
      return photos.map(p => ({
        url: p.src.large,
        thumb: p.src.medium,
        alt: p.alt || term,
        credit: `Photo by ${p.photographer} on Pexels`,
      }));
    } catch {
      continue;
    }
  }
  return null;
}

// Main export — try Google Places photos first, fall back to Pexels.
// Pass photoReferences from the business record for best results.
export async function fetchSectorImages(sectorName, count = 2, { photoReferences, category } = {}) {
  // 1. Real Google business photos (best quality, actual business)
  if (photoReferences?.length) {
    const photos = await fetchGooglePlacesPhotos(photoReferences, count);
    if (photos) {
      console.log(`    [images] fetched ${photos.length} Google Place photo(s) for ${category || sectorName}`);
      return photos;
    }
  }

  // 2. Pexels with category-specific search (generic fallback)
  const photos = await fetchPexelsImages(sectorName, category, count);
  if (photos) {
    console.log(`    [images] fetched ${photos.length} Pexels photo(s) for sector: ${sectorName}`);
    return photos;
  }

  console.log(`    [images] no photos found — using placeholders`);
  return null;
}
