// Companies House API integration — free, but requires an API key.
// Register at: https://developer.company-information.service.gov.uk/
// Add COMPANIES_HOUSE_API_KEY to .env once registered.
// Free tier: 600 requests per 5 minutes — more than enough.

import 'dotenv/config';

const BASE_URL = 'https://api.company-information.service.gov.uk';

// Words that carry no signal for name matching
const STOP_WORDS = new Set([
  'the','and','or','of','in','at','by','for','to','a','an','ltd','limited',
  'llp','plc','co','company','services','solutions','group','scotland',
  'edinburgh','glasgow','london','uk','scotland','scottish',
]);

// Generic "category-as-name" patterns — not worth searching CH for these
const GENERIC_NAME_RE = /^(plumbers?|plasterers?|painters?|joiners?|builders?|electricians?|cleaners?|gardeners?|roofers?|locksmiths?|handymen?|removals?|taxis?|cabs?)\s+(in|near|edinburgh|glasgow|scotland|london)/i;

async function chFetch(path) {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function scoreCandidate(candidate, businessName, postcode, town) {
  let score = 0;

  // Only consider active companies
  if (candidate.company_status !== 'active') return -1;

  const queryWords = businessName.toLowerCase()
    .split(/[\s&,.-]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  const titleWords = candidate.title.toLowerCase()
    .split(/[\s&,.-]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  // Word overlap — most important signal
  const overlap = queryWords.filter(w => titleWords.includes(w)).length;
  if (overlap === 0) return -1; // no meaningful words in common — skip
  score += overlap * 4;

  // Bonus if most of the meaningful words match
  const overlapRatio = overlap / Math.max(queryWords.length, 1);
  if (overlapRatio >= 0.75) score += 5;
  if (overlapRatio >= 1.0)  score += 5;

  // Postcode area match — EH11 from our record vs EH11 in CH address
  const ourArea = postcode?.replace(/\s.*/, '').toUpperCase();
  const theirPostcode = candidate.registered_office_address?.postal_code || '';
  if (ourArea && theirPostcode.toUpperCase().startsWith(ourArea)) score += 6;

  // Scottish company number (SC prefix) for Scottish businesses
  const isScottish = town?.toLowerCase().match(/edinburgh|glasgow|dundee|aberdeen|inverness|stirling/);
  if (isScottish && candidate.company_number?.startsWith('SC')) score += 3;

  // Town name in registered address
  const theirLocality = (candidate.registered_office_address?.locality || '').toLowerCase();
  const ourTown = town?.toLowerCase().replace(/\s*edinburgh\s*/i, '').trim();
  if (ourTown && theirLocality.includes(ourTown)) score += 3;
  if (theirLocality.includes('edinburgh') && isScottish) score += 2;

  return score;
}

export async function lookupCompaniesHouse(businessName, postcode, town) {
  if (!process.env.COMPANIES_HOUSE_API_KEY) return null;

  // Skip generic category-as-name businesses — CH will match noise
  if (GENERIC_NAME_RE.test(businessName.trim())) return null;

  // Skip very short or single-word names — too ambiguous
  const meaningfulWords = businessName.split(/\s+/).filter(w => !STOP_WORDS.has(w.toLowerCase()) && w.length > 2);
  if (meaningfulWords.length < 2) return null;

  // Search with name + postcode for best results
  const query = `${businessName}${postcode ? ` ${postcode}` : ''}`;
  const data = await chFetch(`/search/companies?q=${encodeURIComponent(query)}&items_per_page=5`);
  if (!data?.items?.length) return null;

  // Score all candidates using name, postcode and town signals
  const scored = data.items
    .map(c => ({ ...c, _score: scoreCandidate(c, businessName, postcode, town) }))
    .filter(c => c._score > 0)
    .sort((a, b) => b._score - a._score);

  if (!scored.length) return null;

  const best = scored[0];

  // Require a minimum score to avoid weak matches
  if (best._score < 4) return null;

  // Determine confidence before fetching details (saves API calls on weak matches)
  const queryWords = businessName.toLowerCase()
    .split(/[\s&,.-]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const titleWords = best.title.toLowerCase()
    .split(/[\s&,.-]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const overlap = queryWords.filter(w => titleWords.includes(w)).length;
  const overlapRatio = overlap / Math.max(queryWords.length, 1);

  let confidence;
  if (overlapRatio >= 0.75 && best._score >= 12) confidence = 'high';
  else if (overlap >= 2   && best._score >= 7)  confidence = 'medium';
  else                                           confidence = 'low';

  // Don't bother fetching details for low-confidence matches
  if (confidence === 'low') return null;

  // Fetch full company profile and officers
  const [details, officersData] = await Promise.all([
    chFetch(`/company/${best.company_number}`),
    chFetch(`/company/${best.company_number}/officers?items_per_page=10`),
  ]);

  // Oldest active director = most likely the founder/owner
  const activeDirectors = (officersData?.items || [])
    .filter(o => o.officer_role === 'director' && !o.resigned_on)
    .sort((a, b) => new Date(a.appointed_on || 0) - new Date(b.appointed_on || 0));

  const director = activeDirectors[0] || null;

  const directorRaw = director?.name?.split(',')?.[1]?.trim() || null;
  const directorFirstName = directorRaw
    ? directorRaw.split(' ')[0].charAt(0).toUpperCase() + directorRaw.split(' ')[0].slice(1).toLowerCase()
    : null;

  const incorporatedDate = details?.date_of_creation || best.date_of_creation;
  const incorporatedYear = incorporatedDate ? parseInt(incorporatedDate.slice(0, 4)) : null;

  const sicCode = details?.sic_codes?.[0] || null;
  const sicDescription = sicCode ? (SIC_MAP[sicCode] || null) : null;

  return {
    confidence,
    score: best._score,
    company_number: best.company_number,
    registered_name: best.title,
    incorporated_year: incorporatedYear,
    director_first_name: directorFirstName,
    all_active_directors: activeDirectors.map(o => ({
      name: o.name,
      appointed: o.appointed_on,
      nationality: o.nationality,
      occupation: o.occupation,
    })),
    registered_address: details?.registered_office_address || null,
    company_type: details?.type || null,
    sic_code: sicCode,
    sic_description: sicDescription,
  };
}

// SIC code descriptions for common trades
const SIC_MAP = {
  '41100': 'property development',
  '41201': 'construction of commercial buildings',
  '41202': 'conversion of commercial buildings',
  '43120': 'site preparation',
  '43210': 'electrical installation',
  '43220': 'plumbing, heat and air-conditioning',
  '43290': 'other construction installation',
  '43310': 'plastering',
  '43320': 'joinery installation',
  '43330': 'floor and wall covering',
  '43341': 'painting',
  '43342': 'glazing',
  '43390': 'other building completion and finishing',
  '43910': 'roofing',
  '43991': 'scaffolding',
  '43999': 'other specialised construction',
  '45111': 'sale of new cars',
  '45190': 'sale of other motor vehicles',
  '45200': 'maintenance and repair of motor vehicles',
  '47190': 'other retail in non-specialised stores',
  '47710': 'retail of clothing',
  '47910': 'retail via internet',
  '49320': 'taxi operation',
  '56101': 'licenced restaurants',
  '56102': 'unlicenced restaurants and cafes',
  '56210': 'event catering activities',
  '56290': 'other food service activities',
  '74100': 'specialised design activities',
  '74202': 'photography',
  '81210': 'general cleaning of buildings',
  '81220': 'other building and industrial cleaning',
  '85590': 'other education',
  '86101': 'hospital activities',
  '86900': 'other human health activities',
  '96010': 'laundry and dry-cleaning',
  '96020': 'hairdressing and other beauty treatment',
  '96090': 'other personal service activities',
  '81221': 'window cleaning services',
  '81222': 'specialised cleaning services',
};
