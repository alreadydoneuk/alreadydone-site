import dns from 'dns/promises';

// Known parking provider domains
const PARKING_PROVIDERS = [
  'sedo.com', 'godaddy.com', 'dan.com', 'afternic.com',
  'hugedomains.com', 'namecheap.com', 'bodis.com', 'parkingcrew.com',
  'above.com', 'domainsponsor.com', 'voodoo.com', 'trafficz.com',
];

const PARKING_BODY_SIGNALS = [
  'domain is for sale', 'buy this domain', 'this domain may be for sale',
  'domain parking', 'parked domain', 'parked free',
  'domain not configured', 'web hosting account has been suspended',
  'placeholder page',
];

const COMING_SOON_SIGNALS = [
  'coming soon', 'under construction', 'launching soon',
  'website coming soon', 'site coming soon', 'opening soon',
  'watch this space', "we're coming soon", 'we are coming soon',
];

// Signs a WAF/CDN is protecting a real live site
const WAF_SIGNALS = [
  'cloudflare', 'cf-ray', '__cf_bm', 'attention required',
  'checking your browser', 'ddos-guard', 'just a moment',
  'please wait while we verify', 'enable javascript and cookies',
];

// Signs there is genuine business content on the page
const LIVE_CONTENT_SIGNALS = [
  '<nav', '<header', '<footer', '<main',
  'contact us', 'about us', 'our services', 'call us',
  'get in touch', 'opening hours', 'tel:', 'mailto:',
  'facebook.com/pg', 'instagram.com', 'book now', 'request a quote',
];

// Builder preview subdomains — site mid-build, not broken
const BUILDER_PREVIEW_PATTERNS = [
  'builder-preview.com', 'wixsite.com', 'webflow.io',
  'godaddysites.com', 'myshopify.com', 'weebly.com',
];

// Social media — not a real business domain
const SOCIAL_DOMAINS = [
  'facebook.com', 'instagram.com', 'twitter.com',
  'linkedin.com', 'youtube.com', 'tiktok.com',
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/*
 * Status values returned:
 *   'live'         — working website, skip this lead
 *   'parked'       — domain registered, parking page shown
 *   'coming_soon'  — domain live, explicit coming soon / under construction
 *   'broken_server'— DNS resolves, but server not responding (strongest broken lead)
 *   'broken_dns'   — domain doesn't resolve at all (weaker lead)
 *   'broken'       — HTTP error / unclear (moderate lead)
 *   'none'         — no website URL provided
 *   'social'       — URL is a social media profile, not a domain
 */
export async function checkDomain(websiteUri) {
  if (!websiteUri) return 'none';

  let hostname, origin;
  try {
    const url = new URL(websiteUri.startsWith('http') ? websiteUri : `https://${websiteUri}`);
    hostname = url.hostname;
    origin = url.origin;
  } catch {
    return 'broken';
  }

  const bare = hostname.replace(/^www\./, '');

  // Social media profiles are not domains
  if (SOCIAL_DOMAINS.some(s => bare === s || bare.endsWith('.' + s))) return 'social';

  // Builder preview subdomains — site being built, treat as live
  if (BUILDER_PREVIEW_PATTERNS.some(p => hostname.includes(p))) return 'live';

  // Known parking providers directly in URL
  if (PARKING_PROVIDERS.some(p => hostname.includes(p))) return 'parked';

  // ── Layer 1: DNS resolution ──────────────────────────────────────────────
  // If DNS fails the domain is gone/expired — definitely no working site.
  // If DNS resolves, the domain is actively maintained, so HTTP failure = real problem.
  const dnsOk = await resolveDns(bare);

  // ── Layer 2: HTTP attempts ───────────────────────────────────────────────
  // Try up to 3 times across https + http, with and without www.
  const candidates = [
    `https://${bare}`,
    `https://www.${bare}`,
    `http://${bare}`,
  ];

  for (const attempt of candidates) {
    const result = await httpCheck(attempt);
    if (result === null) continue; // connection failed, try next

    const { status, finalUrl, body } = result;

    // Redirected to a parking provider
    if (PARKING_PROVIDERS.some(p => finalUrl.includes(p))) return 'parked';

    // WAF challenge = real protected site
    if (WAF_SIGNALS.some(s => body.includes(s))) return 'live';

    // Count live content signals first — a real site will have several
    const liveCount = LIVE_CONTENT_SIGNALS.filter(s => body.includes(s)).length;

    // If multiple live signals are present, trust them over coming_soon/parking text
    // (e.g. a site with a "some pages under construction" banner is still a live site)
    if (liveCount >= 3) return 'live';

    // Coming soon — only if the page lacks real content
    if (liveCount < 2 && COMING_SOON_SIGNALS.some(s => body.includes(s))) return 'coming_soon';

    // Parking signals in body
    if (PARKING_BODY_SIGNALS.some(s => body.includes(s))) return 'parked';

    // Two live signals = live
    if (liveCount >= 2) return 'live';

    // Very small page with no structure = probably parked
    if (body.length < 2000 && liveCount === 0 && status === 200) return 'parked';

    // Got a 4xx/5xx — domain is up but page errors
    if (status >= 400) return 'broken';

    // Got a 200 and body is substantial but no clear live signals —
    // safer to treat as live than risk emailing someone with a working site
    if (status === 200 && body.length > 2000) return 'live';
  }

  // All HTTP attempts failed
  if (dnsOk) {
    // DNS resolves but nothing responds — server is genuinely down
    return 'broken_server';
  } else {
    // DNS doesn't resolve — domain may be expired or misconfigured
    return 'broken_dns';
  }
}

async function resolveDns(hostname) {
  try {
    await dns.resolve(hostname);
    return true;
  } catch {
    try {
      // Try www prefix as fallback
      await dns.resolve(`www.${hostname}`);
      return true;
    } catch {
      return false;
    }
  }
}

async function httpCheck(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(9000),
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    const body = (await response.text()).toLowerCase();
    return { status: response.status, finalUrl: response.url || url, body };
  } catch {
    return null;
  }
}

export function extractDomain(websiteUri) {
  try {
    const url = new URL(websiteUri.startsWith('http') ? websiteUri : `https://${websiteUri}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Any status that is NOT a confirmed working site is a prospect.
// We no longer discard broken_dns, broken, or none — all go into the pipeline
// as cold/warm leads and feed the Found Local directory regardless.
export function isQualifiedLead(websiteStatus) {
  return !['live', 'social', null, undefined].includes(websiteStatus);
}

// Keyword-stuffed SEO doorway domains follow predictable patterns.
// They're created by agencies, get abandoned, and are rarely a business's main site.
// If the real business website exists, it's at a different domain we can't check.
export function isKeywordStuffedDomain(domain) {
  // Pattern: very long domain (20+ chars before TLD) with city/service keywords
  const bare = domain.replace(/\.(co\.uk|co|uk|com|net|org)$/, '');
  if (bare.length < 20) return false;

  const cityKeywords = ['london', 'manchester', 'birmingham', 'leeds', 'sheffield',
    'liverpool', 'bristol', 'edinburgh', 'glasgow', 'cardiff', 'nottingham',
    'leicester', 'coventry', 'bradford', 'newcastle', 'stoke', 'derby',
    'harehills', 'northampton', 'portsmouth', 'brighton', 'plymouth'];

  const serviceKeywords = ['emergency', 'plumber', 'plumbing', 'heating', 'electrician',
    'builder', 'locksmith', 'roofer', 'painter', 'cleaner', 'removal',
    'local', 'cheap', 'fast', 'same.?day', '24.?7', 'near.?me'];

  const lowerDomain = bare.toLowerCase();
  const hasCity = cityKeywords.some(c => lowerDomain.includes(c));
  const hasService = serviceKeywords.some(s => new RegExp(s).test(lowerDomain));

  return hasCity && hasService;
}

export function leadTier(websiteStatus) {
  if (['parked', 'coming_soon'].includes(websiteStatus)) return 1;
  if (websiteStatus === 'broken_server') return 2;
  if (['broken', 'broken_dns', 'seo_doorway', 'none'].includes(websiteStatus)) return 3;
  return 3;
}

// Lead temperature — email automation only, no phone.
// hasMx: whether the domain has active MX records (email deliverable).
export function leadTemperature(websiteStatus, hasDomain, hasMx) {
  if (!hasDomain) return 'cold'; // no domain = no email hook, no automated contact

  const strongNeed = ['parked', 'coming_soon', 'broken_server'].includes(websiteStatus);
  const weakNeed   = ['broken', 'broken_dns', 'seo_doorway'].includes(websiteStatus);

  if (hasMx && strongNeed) return 'hot';
  if (hasMx && weakNeed)   return 'warm';
  if (!hasMx && strongNeed) return 'warm'; // domain hook exists, email route uncertain
  return 'cold';
}

export function isEmailable(websiteStatus) {
  // none/social = Ghost cohort: no domain, but Serper found a real email (Gmail etc) — deliverable
  // seo_doorway = real business behind a keyword-stuffed domain — treat as contactable
  return ['parked', 'coming_soon', 'broken_server', 'broken', 'none', 'social', 'seo_doorway'].includes(websiteStatus);
}
