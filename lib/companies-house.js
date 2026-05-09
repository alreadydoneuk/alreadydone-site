// Companies House API integration — free, but requires an API key.
// Register at: https://developer.company-information.service.gov.uk/
// Add COMPANIES_HOUSE_API_KEY to .env once registered.
// Free tier: 600 requests per 5 minutes — more than enough.

import 'dotenv/config';

const BASE_URL = 'https://api.company-information.service.gov.uk';

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

export async function lookupCompaniesHouse(businessName, postcode) {
  if (!process.env.COMPANIES_HOUSE_API_KEY) return null;

  // Search by name, optionally filtered by location
  const query = `${businessName}${postcode ? ` ${postcode}` : ''}`;
  const data = await chFetch(`/search/companies?q=${encodeURIComponent(query)}&items_per_page=3`);
  if (!data?.items?.length) return null;

  // Find the closest match: active company with a name that shares most words
  const nameWords = new Set(businessName.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const best = data.items
    .filter(c => c.company_status === 'active')
    .map(c => {
      const match = c.title.toLowerCase().split(/\s+/).filter(w => nameWords.has(w)).length;
      return { ...c, matchScore: match };
    })
    .sort((a, b) => b.matchScore - a.matchScore)[0];

  if (!best || best.matchScore < 1) return null;

  // Fetch full company details for director info
  const details = await chFetch(`/company/${best.company_number}`);
  const officers = await chFetch(`/company/${best.company_number}/officers?items_per_page=5`);

  // Find the active director
  const director = officers?.items
    ?.filter(o => o.officer_role === 'director' && !o.resigned_on)
    ?.sort((a, b) => new Date(a.appointed_on || 0) - new Date(b.appointed_on || 0))[0];

  const incorporatedDate = details?.date_of_creation || best.date_of_creation;
  const incorporatedYear = incorporatedDate ? parseInt(incorporatedDate.slice(0, 4)) : null;

  const directorName = director?.name
    ? director.name.split(',')[1]?.trim().split(' ')[0] || null  // "SMITH, JOHN JAMES" → "JOHN" → "John"
    : null;
  const directorFirstName = directorName
    ? directorName.charAt(0).toUpperCase() + directorName.slice(1).toLowerCase()
    : null;

  const sicDescription = details?.sic_codes?.[0]
    ? await getSicDescription(details.sic_codes[0])
    : null;

  return {
    company_number: best.company_number,
    registered_name: best.title,
    incorporated_year: incorporatedYear,
    director_first_name: directorFirstName,
    company_type: details?.type || null,
    sic_description: sicDescription,
  };
}

// SIC code descriptions for common trades — fallback if no lookup
const SIC_MAP = {
  '43210': 'electrical installation',
  '43220': 'plumbing, heat and air-conditioning',
  '43310': 'plastering',
  '43320': 'joinery installation',
  '43330': 'floor and wall covering',
  '43341': 'painting',
  '43342': 'glazing',
  '43390': 'other building completion and finishing',
  '43120': 'site preparation',
  '41202': 'conversion of commercial buildings',
  '47910': 'retail via internet',
  '56101': 'licenced restaurants',
  '56102': 'unlicenced restaurants and cafes',
  '56210': 'event catering activities',
  '96020': 'hairdressing and other beauty treatment',
  '96090': 'other personal service activities',
};

async function getSicDescription(code) {
  return SIC_MAP[code] || null;
}
