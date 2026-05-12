import 'dotenv/config';
import { scrapeBusinessWebsite } from './website-scraper.js';
import { synthesizeBusinessBrief } from './claude.js';
import { lookupCompaniesHouse } from './companies-house.js';

const SERPER_URL = 'https://google.serper.dev/search';
const WAYBACK_CDX = 'http://web.archive.org/cdx/search/cdx';

const ACCREDITATION_PATTERNS = [
  { pattern: /gas safe/i,                       label: 'Gas Safe registered' },
  { pattern: /niceic/i,                         label: 'NICEIC approved contractor' },
  { pattern: /which\??\s*trusted/i,             label: 'Which? Trusted Trader' },
  { pattern: /checkatrade/i,                    label: 'Checkatrade member' },
  { pattern: /trading standards/i,              label: 'Trading Standards approved' },
  { pattern: /fensa/i,                          label: 'FENSA registered' },
  { pattern: /corgi/i,                          label: 'CORGI registered' },
  { pattern: /napit/i,                          label: 'NAPIT certified' },
  { pattern: /city\s*&?\s*guilds/i,             label: 'City & Guilds qualified' },
  { pattern: /ofsted/i,                         label: 'Ofsted registered' },
  { pattern: /hmrc/i,                           label: 'HMRC registered' },
  { pattern: /chas/i,                           label: 'CHAS accredited' },
  { pattern: /constructionline/i,               label: 'Constructionline registered' },
  { pattern: /safecontractor/i,                 label: 'SafeContractor approved' },
  { pattern: /trustmark/i,                      label: 'TrustMark registered' },
  { pattern: /british standards|bs\s*\d{4}/i,  label: 'British Standards compliant' },
  { pattern: /iso\s*\d{3,}/i,                  label: 'ISO certified' },
  { pattern: /nhs\s*approved|nhs\s*registered/i, label: 'NHS approved' },
  { pattern: /federation\s*of\s*master\s*builders|fmb/i, label: 'Federation of Master Builders member' },
  { pattern: /electrical\s*safety\s*first/i,   label: 'Electrical Safety First approved' },
  { pattern: /british\s*institute\s*of\s*interior\s*design|biid/i, label: 'BIID member' },
];

const SOCIAL_DOMAINS = [
  { pattern: /facebook\.com/,   key: 'facebook' },
  { pattern: /instagram\.com/,  key: 'instagram' },
  { pattern: /twitter\.com|x\.com/, key: 'twitter' },
  { pattern: /linkedin\.com/,   key: 'linkedin' },
  { pattern: /tiktok\.com/,     key: 'tiktok' },
  { pattern: /youtube\.com/,    key: 'youtube' },
];

// Domains that are directories, aggregators, or platforms — not the business's own site
const AGGREGATOR_PATTERNS = [
  /facebook\.com/, /instagram\.com/, /twitter\.com/, /x\.com/, /linkedin\.com/,
  /tiktok\.com/, /youtube\.com/, /pinterest\.com/, /whatsapp\.com/,
  /yell\.com/, /checkatrade\.com/, /trustpilot\.com/, /houzz\.com/, /bark\.com/,
  /rated\.people\.com/, /mybuilder\.com/, /treatwell\.co/, /freeindex\.co\.uk/,
  /tripadvisor\./, /google\.com/, /google\.co\.uk/, /yelp\./, /bing\.com/,
  /192\.com/, /company-information\.service\.gov\.uk/, /web\.archive\.org/,
  /bbc\.co\.uk/, /theguardian\.com/, /telegraph\.co\.uk/, /scotsman\.com/, /heraldscotland\.com/,
  /\.gov\.uk/, /ofsted\.gov\.uk/, /checkmyfile\.com/,
  /yellowpages\./, /brownbook\.net/, /scoot\.co\.uk/, /cyclex\.co\.uk/, /fyple\.co\.uk/,
  /nextdoor\.com/, /gumtree\.com/, /facebook\.com/, /reddit\.com/,
  /companies\.house\.gov\.uk/, /duedil\.com/, /bizdb\.co\.uk/,
  /visitscotland\.com/, /visitengland\.com/, /visithub\.com/,
  /1stchoice\.co\.uk/, /ratedpeople\.com/, /designmynight\.com/,
  /timeout\.com/, /yelp\.co\.uk/,
];

function isAggregator(url) {
  return AGGREGATOR_PATTERNS.some(p => p.test(url));
}

// Detects a business's own website in Serper results that we didn't know about.
// Returns { url, title, snippet } if a match is found, else null.
function detectExistingWebsite(results, business) {
  const nameWords = business.name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'ltd', 'limited', 'llp', 'plc'].includes(w));

  if (!nameWords.length) return null;

  for (const r of results) {
    const url = r.link || '';
    if (!url.startsWith('http')) continue;
    if (isAggregator(url)) continue;

    let hostname = '';
    try {
      hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      continue;
    }

    const title = (r.title || '').toLowerCase();

    // Strong signal: domain contains at least one business name word
    const domainMatch = nameWords.some(w => hostname.includes(w));
    // Supporting signal: title contains most of the business name words
    const titleWordHits = nameWords.filter(w => title.includes(w)).length;
    const titleMatch = titleWordHits >= Math.max(1, Math.ceil(nameWords.length * 0.6));

    if (domainMatch && titleMatch) {
      return { url, title: r.title, snippet: (r.snippet || '').slice(0, 200) };
    }
  }
  return null;
}

const REVIEW_PLATFORMS = [
  { pattern: /yell\.com/,        name: 'Yell' },
  { pattern: /checkatrade\.com/, name: 'Checkatrade' },
  { pattern: /trustpilot\.com/,  name: 'Trustpilot' },
  { pattern: /houzz\.com/,       name: 'Houzz' },
  { pattern: /bark\.com/,        name: 'Bark' },
  { pattern: /rated\.people\.com/, name: 'Rated People' },
  { pattern: /mybuilder\.com/,   name: 'MyBuilder' },
  { pattern: /treatwell\.co/,    name: 'Treatwell' },
];

async function serperSearch(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'gb', hl: 'en', num: 10 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.organic || [];
  } catch { return []; }
}

function extractYears(text) {
  const yearMatch = text.match(/(?:established|founded|est\.?|since|trading since|serving\s+\w+\s+since|in business since|opened in)\s+(?:in\s+)?(\d{4})/i);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    if (year >= 1900 && year <= new Date().getFullYear()) {
      return { year, yearsTrading: new Date().getFullYear() - year };
    }
  }
  const yearsMatch = text.match(/(?:over|more than|nearly|almost|[\d]+\+)\s+(\d+)\s+years?/i)
    || text.match(/(\d+)\+?\s+years?\s+(?:of\s+)?(?:experience|trading|in business|serving)/i);
  if (yearsMatch) {
    const y = parseInt(yearsMatch[1]);
    if (y >= 1 && y <= 100) return { yearsTrading: y };
  }
  return null;
}

function extractAccreditations(text) {
  return ACCREDITATION_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);
}

function extractAreasServed(text) {
  const match = text.match(/(?:serv(?:ing|es?)|cover(?:ing|s?)|based\s+in\s+\w+,?\s+(?:serving|covering))\s+([A-Z][^.!?\n]{5,80})/i);
  if (match) {
    const areas = match[1].trim();
    if ((areas.match(/[A-Z]/g) || []).length >= 2) return areas;
  }
  return null;
}

function extractOwnerName(results, businessName) {
  // Every word in the business name — skip any match that's part of the business name
  const businessWords = new Set(
    businessName.toLowerCase().split(/\s+/).filter(w => w.length > 1)
  );
  const ownerPatterns = [
    /(?:owner|founder|proprietor|run by|managed by|director)[,\s]+([A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15})?)/,
    /([A-Z][a-z]{2,15})\s+(?:started|opened|founded|established)\s+(?:the\s+)?(?:business|shop|company|studio|salon)/,
    /(?:meet|chat with|speaking to)\s+([A-Z][a-z]{2,15})/,
    /(?:hi,?\s+i'm|my name is|i am)\s+([A-Z][a-z]{2,15})/i,
  ];

  for (const r of results) {
    const text = `${r.title || ''} ${r.snippet || ''}`;
    for (const pattern of ownerPatterns) {
      const match = text.match(pattern);
      if (match) {
        const name = match[1].trim();
        const nameWords = name.toLowerCase().split(/\s+/);
        if (nameWords.some(w => businessWords.has(w))) continue;
        if (/^(the|this|our|your|their|local|new|best|great|good|we|he|she|they)$/i.test(name)) continue;
        if (name.length >= 3 && name.length <= 30) return name;
      }
    }
  }
  return null;
}

function isSocialProfileUrl(key, url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, ''); // strip trailing slash
    const segments = path.split('/').filter(Boolean);

    // No query strings — they indicate tracking redirects, locale params, or content posts
    if (u.search) return false;

    if (key === 'facebook') {
      // Valid: facebook.com/{pagename} — exactly one path segment, no subpages
      // Invalid: /posts/, /photos/, /videos/, /groups/, /events/, /permalink/, /story/, /p/, /people/, /share/
      const BAD = /^(posts|photos|videos|groups|events|permalink|story|p|people|share|pg|pages|marketplace|ads|gaming|watch|sharer)$/i;
      return segments.length === 1 && !BAD.test(segments[0]);
    }
    if (key === 'instagram') {
      // Valid: instagram.com/{username} — one segment username (no @ prefix in URL)
      // Invalid: /p/, /reel/, /tv/, /stories/, /explore/, /accounts/
      const BAD = /^(p|reel|tv|stories|explore|accounts|popular|directory|_n|_u)$/i;
      return segments.length === 1 && !BAD.test(segments[0]);
    }
    if (key === 'twitter') {
      // Valid: twitter.com/{username} or x.com/{username} — one segment
      // Invalid: /status/, /i/, /search, /hashtag/
      const BAD = /^(status|i|search|hashtag|explore|home|notifications|messages|intent|share)$/i;
      return segments.length === 1 && !BAD.test(segments[0]);
    }
    if (key === 'linkedin') {
      // Valid: linkedin.com/company/{name} — must be a company page, not personal (/in/)
      return segments.length === 2 && segments[0] === 'company';
    }
    if (key === 'tiktok') {
      // Valid: tiktok.com/@{username} — starts with @
      return segments.length === 1 && segments[0].startsWith('@');
    }
    if (key === 'youtube') {
      // Valid: youtube.com/@channel, /channel/{id}, /c/{name}, /user/{name}
      const OK = /^(@|channel|c|user)$/i;
      return (segments.length === 1 && segments[0].startsWith('@')) ||
             (segments.length === 2 && OK.test(segments[0]));
    }
    return false;
  } catch { return false; }
}

function extractSocialLinks(results) {
  const found = {};
  for (const r of results) {
    const url = r.link || '';
    for (const { pattern, key } of SOCIAL_DOMAINS) {
      if (!found[key] && pattern.test(url) && isSocialProfileUrl(key, url)) {
        found[key] = url;
      }
    }
  }
  return Object.keys(found).length ? found : null;
}

function extractReviewPlatforms(results) {
  const found = [];
  for (const r of results) {
    const url = r.link || '';
    for (const { pattern, name } of REVIEW_PLATFORMS) {
      if (pattern.test(url) && !found.find(f => f.name === name)) {
        // Try to pull a review count or rating from the snippet
        const snippet = r.snippet || '';
        const ratingMatch = snippet.match(/(\d+(?:\.\d+)?)\s*(?:out of 5|\/5|\s*stars?)/i);
        const countMatch = snippet.match(/(\d+)\s*reviews?/i);
        found.push({
          name,
          url,
          rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
          review_count: countMatch ? parseInt(countMatch[1]) : null,
          snippet: snippet.slice(0, 120),
        });
      }
    }
  }
  return found.length ? found : null;
}

function extractUSPs(results, businessName) {
  // Pull sentences from snippets that describe what makes the business distinctive
  const usps = [];
  const seen = new Set();

  for (const r of results) {
    const snippet = r.snippet || '';
    // Sentences that contain specificity signals
    const sentences = snippet.split(/[.!?]/).map(s => s.trim()).filter(s => s.length > 20 && s.length < 200);
    for (const s of sentences) {
      const lower = s.toLowerCase();
      const isSpecific = (
        /handmade|bespoke|artisan|family.?run|independent|award|specialist|only|unique|original|oak.?smoked|on.?the.?prem|in.?house|locally|sustainable|organic|free.?range|seasonal|foraged/i.test(s) ||
        /since \d{4}|est\.?\s*\d{4}|\d+.?years?/i.test(s) ||
        /named|voted|featured|press|bbc|guardian|scotsman|herald/i.test(s)
      );
      if (isSpecific && !seen.has(lower.slice(0, 40))) {
        seen.add(lower.slice(0, 40));
        usps.push(s);
      }
    }
  }
  return usps.slice(0, 5);
}

function extractHistoryStory(results) {
  // Look for founding/history narrative in EdinPhoto, local news, About pages
  const historyPatterns = [
    /(?:started|opened|founded|began|took over|established)\s+.{5,200}(?:year|decade|\d{4})/i,
    /(?:father|family|generation|grandfather|heritage|tradition).{5,150}/i,
  ];

  for (const r of results) {
    // Prefer editorial/local sources over directories
    const isEditorial = /edinphoto|scotsman|herald|bbc|theguardian|edinburgh\.gov|visit|timeout/i.test(r.link || '');
    if (!isEditorial) continue;
    const text = `${r.title || ''} ${r.snippet || ''}`;
    for (const pattern of historyPatterns) {
      const match = text.match(pattern);
      if (match) return match[0].trim().slice(0, 300);
    }
  }
  return null;
}

function extractCommunityMentions(results) {
  // Reddit, local blogs, news — signals real community trust
  const mentions = [];
  for (const r of results) {
    const url = r.link || '';
    const isCommUnity = /reddit\.com|tripadvisor|timeout|scotsman|herald|thisisedinburgh|edinphoto|visitscotland/i.test(url);
    if (isCommUnity && r.snippet) {
      mentions.push({ source: new URL(url).hostname.replace('www.', ''), snippet: r.snippet.slice(0, 120) });
    }
  }
  return mentions.length ? mentions.slice(0, 3) : null;
}

async function waybackFirstSeen(domain) {
  if (!domain) return null;
  try {
    const url = `${WAYBACK_CDX}?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp&filter=statuscode:200&collapse=timestamp:4`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    // data[0] is header row, data[1] is first result
    if (!data || data.length < 2) return null;
    const ts = data[1][0];
    const year = parseInt(ts.slice(0, 4));
    return year >= 1996 && year <= new Date().getFullYear() ? year : null;
  } catch { return null; }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function enrichBusinessForSiteBuild(business) {
  const { name, location, category, domain, website_status, whois_registered_date } = business;
  const city = (location || '').split(' ').pop();

  // Run all sources in parallel
  const canScrapeWebsite = website_status === 'live' && domain;
  const [generalResults, socialResults, reviewResults, websiteData, waybackYear, chData] = await Promise.all([
    serperSearch(`"${name}" "${city}"`),
    serperSearch(`"${name}" ${city} site:facebook.com OR site:instagram.com OR site:twitter.com`),
    serperSearch(`"${name}" ${city} reviews OR checkatrade OR yell OR trustpilot`),
    canScrapeWebsite ? scrapeBusinessWebsite(domain, name).catch(() => null) : Promise.resolve(null),
    domain ? waybackFirstSeen(domain).catch(() => null) : Promise.resolve(null),
    process.env.COMPANIES_HOUSE_API_KEY
      ? lookupCompaniesHouse(name, business.postcode, business.town || business.location).catch(() => null)
      : Promise.resolve(null),
  ]);

  const allResults = [...generalResults, ...socialResults, ...reviewResults];

  if (!allResults.length && !websiteData) return null;

  // All snippets for cross-search extraction
  const allSnippets = allResults
    .map(r => r.snippet || '')
    .filter(s => s.length > 20);
  const combined = allSnippets.join(' ');

  // Extract everything
  const established = extractYears(combined);
  const accreditations = extractAccreditations(combined);
  const areasServed = extractAreasServed(combined);
  const ownerName = extractOwnerName(allResults, name);
  const socialLinks = extractSocialLinks([...generalResults, ...socialResults]);
  const reviewPlatforms = extractReviewPlatforms([...generalResults, ...reviewResults]);
  const usps = extractUSPs(allResults, name);
  const historyStory = extractHistoryStory(allResults);
  const communityMentions = extractCommunityMentions(allResults);

  // Best snippets for Claude: prefer general results, deduplicate
  const seen = new Set();
  const topSnippets = allResults
    .map(r => r.snippet || '')
    .filter(s => {
      if (s.length < 20) return false;
      const key = s.slice(0, 40);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);

  // Merge owner name: Companies House director > website > Serper pattern (confidence order)
  const finalOwnerName = chData?.director_first_name || websiteData?.owner_name || ownerName;

  // Merge accreditations from all sources
  const allAccreditations = [
    ...(accreditations || []),
    ...(websiteData?.site_accreditations || []),
  ].filter((v, i, a) => a.indexOf(v) === i);

  // Best established year: Companies House incorporation > Serper snippet > WHOIS > Wayback
  const whoisYear = whois_registered_date ? parseInt(whois_registered_date.slice(0, 4)) : null;
  const establishedYear = chData?.incorporated_year || established?.year || null;
  const webPresenceSince = waybackYear || whoisYear || null;

  const context = {
    established: establishedYear,
    years_trading: established?.yearsTrading || null,
    web_presence_since: webPresenceSince,
    accreditations: allAccreditations.length ? allAccreditations : null,
    areas_served: websiteData?.areas_served || areasServed,
    owner_name: finalOwnerName,
    social_links: socialLinks,
    review_platforms: reviewPlatforms,
    usps: usps.length ? usps : null,
    history_story: historyStory,
    community_mentions: communityMentions,
    raw_snippets: topSnippets,
    // Website-scraped data
    site_services_copy: websiteData?.services_copy || null,
    site_testimonials: websiteData?.site_testimonials || null,
    site_text_excerpt: websiteData?.raw_text_excerpt || null,
    // Companies House (when API key configured)
    companies_house: chData ? {
      registered_name: chData.registered_name,
      incorporated_year: chData.incorporated_year,
      company_type: chData.company_type,
    } : null,
  };

  const hasContext = context.established || context.web_presence_since
    || context.accreditations?.length || context.owner_name || context.social_links
    || context.usps?.length || context.raw_snippets.length || context.site_text_excerpt;

  // Pre-build safety check: detect if enrichment reveals the business now has a working website.
  // Only run for Ghost/no-domain businesses — Dark businesses already have a known domain.
  if (!business.domain) {
    const discovered = detectExistingWebsite(generalResults, business);
    if (discovered) {
      context.discovered_website = discovered;
      return context; // Return early — caller should skip this business
    }
  }

  if (!hasContext) return null;

  // Haiku synthesis: distil all raw data into a structured brief
  const brief = await synthesizeBusinessBrief(name, category, context).catch(() => null);
  if (brief) context.brief = brief;

  return context;
}
