// Scrapes a business's own website for enrichment data.
// Only called when website_status is 'live' and domain is set.

const ABOUT_PATTERNS = [/\/about/i, /\/our-story/i, /\/who-we-are/i, /\/team/i, /\/story/i, /\/history/i];
const MAX_TEXT = 3000;

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
      redirect: 'follow',
    });
    if (!res.ok || !res.headers.get('content-type')?.includes('html')) return null;
    return await res.text();
  } catch { return null; }
}

function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function findAboutLinks(html, baseUrl) {
  const links = [];
  const hrefs = html.matchAll(/href=["']([^"'#?]+)["']/gi);
  for (const [, href] of hrefs) {
    if (ABOUT_PATTERNS.some(p => p.test(href))) {
      try {
        const url = new URL(href, baseUrl);
        if (url.hostname === new URL(baseUrl).hostname) {
          links.push(url.href);
        }
      } catch {}
    }
  }
  return [...new Set(links)].slice(0, 2);
}

function extractFromText(text, businessName) {
  const found = {};

  // Founding year
  const yearMatch = text.match(/(?:established|founded|est\.?|since|opened|started|trading since|in business since)\s+(?:in\s+)?(\d{4})/i)
    || text.match(/(\d{4})\s*[–—-]\s*(?:present|today)/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1]);
    if (y >= 1900 && y <= new Date().getFullYear()) found.founded_year = y;
  }

  // Owner/founder name from website copy
  const ownerPatterns = [
    /(?:owner|founder|proprietor|run by|managed by|founded by|set up by)[,\s:]+([A-Z][a-z]{2,15}(?:\s+[A-Z][a-z]{1,15})?)/,
    /(?:hi|hello|i'm|i am|my name is)[,\s]+([A-Z][a-z]{2,15})/i,
    /(?:meet|from)\s+([A-Z][a-z]{2,15}),\s+(?:your|our|the)/,
  ];
  const businessWords = new Set(businessName.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  for (const pattern of ownerPatterns) {
    const m = text.match(pattern);
    if (m) {
      const name = m[1].trim();
      if (!name.toLowerCase().split(/\s+/).some(w => businessWords.has(w))
        && !/^(the|this|our|your|we|he|she|they|local|new|best|great)$/i.test(name)) {
        found.owner_name = name;
        break;
      }
    }
  }

  // Services/specialisms — extract noun phrases near service signals
  const serviceMatch = text.match(/(?:we (?:offer|provide|specialise in|specialize in)|our services include|what we do)[^.!?]{10,300}/i);
  if (serviceMatch) found.services_copy = serviceMatch[0].trim().slice(0, 200);

  // Awards/accreditations mentioned on site
  const accredPatterns = [
    { pattern: /gas safe/i, label: 'Gas Safe registered' },
    { pattern: /niceic/i, label: 'NICEIC approved' },
    { pattern: /which\??\s*trusted/i, label: 'Which? Trusted Trader' },
    { pattern: /checkatrade/i, label: 'Checkatrade member' },
    { pattern: /trustmark/i, label: 'TrustMark registered' },
    { pattern: /fensa/i, label: 'FENSA registered' },
    { pattern: /napit/i, label: 'NAPIT certified' },
    { pattern: /iso\s*\d{3,}/i, label: 'ISO certified' },
    { pattern: /award.{0,20}winner|winner.{0,20}award/i, label: 'award-winning' },
    { pattern: /fully\s+insured/i, label: 'fully insured' },
    { pattern: /dbs\s+check/i, label: 'DBS checked' },
    { pattern: /city\s*&?\s*guilds/i, label: 'City & Guilds qualified' },
  ];
  const accreditations = accredPatterns.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
  if (accreditations.length) found.site_accreditations = accreditations;

  // Testimonials/review quotes
  const quotePattern = /"([^"]{30,200})"|'([^']{30,200})'/g;
  const quotes = [];
  let qm;
  while ((qm = quotePattern.exec(text)) !== null && quotes.length < 3) {
    const q = (qm[1] || qm[2]).trim();
    if (q.split(' ').length >= 6) quotes.push(q);
  }
  if (quotes.length) found.site_testimonials = quotes;

  // Areas served
  const areaMatch = text.match(/(?:serv(?:ing|es?)|cover(?:ing|s?)|based in[^,]+,?\s+(?:serving|covering))\s+([A-Z][^.!?\n]{10,100})/i);
  if (areaMatch && (areaMatch[1].match(/[A-Z]/g) || []).length >= 2) {
    found.areas_served = areaMatch[1].trim().slice(0, 150);
  }

  return found;
}

export async function scrapeBusinessWebsite(domain, businessName) {
  if (!domain) return null;

  const baseUrl = `https://${domain}`;
  const homeHtml = await fetchPage(baseUrl);
  if (!homeHtml) return null;

  const pages = [homeHtml];
  const aboutLinks = findAboutLinks(homeHtml, baseUrl);
  for (const link of aboutLinks) {
    const html = await fetchPage(link);
    if (html) pages.push(html);
  }

  const combinedText = pages.map(htmlToText).join(' ').slice(0, MAX_TEXT);
  const extracted = extractFromText(combinedText, businessName);

  const hasContent = Object.keys(extracted).length > 0;
  return hasContent ? { ...extracted, raw_text_excerpt: combinedText.slice(0, 500) } : null;
}
