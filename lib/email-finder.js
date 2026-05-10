import dns from 'dns/promises';

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/get-in-touch'];
const EMAIL_REGEX = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/;
const ASSET_REGEX = /\.(png|jpg|gif|svg|css|js|woff|ico)$/i;
const JUNK_DOMAINS = ['example.com', 'domain.com', 'yourdomain.com', 'email.com', 'sentry.io', 'cloudflare.com', 'wixpress.com', 'wixsite.com', 'wix.com'];

// Consumer email providers — an address here means the email goes directly to the owner
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de',
  'outlook.com', 'outlook.co.uk',
  'live.com', 'live.co.uk',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.fr',
  'icloud.com', 'me.com', 'mac.com',
  'btinternet.com', 'btopenworld.com',
  'sky.com', 'talktalk.net',
  'virginmedia.com', 'ntlworld.com',
  'aol.com', 'aol.co.uk',
  'protonmail.com', 'pm.me',
]);

export function isGenericEmailDomain(email) {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? GENERIC_EMAIL_DOMAINS.has(domain) : false;
}

export async function findEmail(domain, businessName) {
  // 1. Try to scrape emails from homepage and contact pages
  for (const path of CONTACT_PATHS) {
    const found = await scrapeEmailFromPage(`https://${domain}${path}`);
    if (found) return { email: found, source: 'page_scrape' };
  }

  // 2. Try common patterns — verify MX records exist first
  const mxExists = await hasMxRecord(domain);
  if (mxExists) {
    const pattern = bestPatternForName(businessName);
    return { email: `${pattern}@${domain}`, source: 'pattern' };
  }

  return { email: null, source: 'not_found' };
}

async function scrapeEmailFromPage(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; contact-finder/1.0)' },
      redirect: 'follow',
    });

    if (!response.ok) return null;
    const body = await response.text();

    // mailto: links are most reliable
    const mailtoMatches = [...body.matchAll(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi)];
    for (const m of mailtoMatches) {
      const candidate = m[1].toLowerCase();
      if (!isJunk(candidate)) return candidate;
    }

    // General email regex — scan whole body
    const allMatches = [...body.matchAll(new RegExp(EMAIL_REGEX.source, 'g'))];
    for (const m of allMatches) {
      const candidate = m[1].toLowerCase();
      if (!isJunk(candidate) && !ASSET_REGEX.test(candidate)) return candidate;
    }

    return null;
  } catch {
    return null;
  }
}

function isJunk(email) {
  const domain = email.split('@')[1] || '';
  return JUNK_DOMAINS.some(j => domain === j || domain.endsWith('.' + j));
}

async function hasMxRecord(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

function bestPatternForName(businessName) {
  const first = businessName.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  if (first.length >= 3 && first.length <= 12) return first;
  return 'info';
}

