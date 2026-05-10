import 'dotenv/config';
import { lookup as whoisLookup } from 'whois';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SERPER_URL = 'https://google.serper.dev/search';

const EMAIL_JUNK_DOMAINS = new Set([
  'example.com', 'domain.com', 'yourdomain.com', 'yoursite.com',
  'website.com', 'email.com', 'sentry.io', 'cloudflare.com',
  'wixpress.com', 'wixsite.com', 'wix.com',
  'wordpress.com', 'squarespace.com', 'shopify.com', 'google.com',
  'googleapis.com', 'schema.org', 'w3.org', 'openstreetmap.org',
  'facebook.com', 'instagram.com', 'yabsta.net',
  // Marketplace/booking platforms — their contact email appears on business listing pages
  'tailster.com', 'bark.com', 'treatwell.co.uk', 'fresha.com',
  'booksy.com', 'styleseat.com', 'vagaro.com', 'mindbodyonline.com',
  'gumtree.com', 'fixr.co.uk', 'nextdoor.com', 'taskrabbit.co.uk',
]);

// Aggregator/directory pages that list multiple unrelated businesses —
// emails found here almost certainly belong to someone else on the page
const BLOCKED_DOMAINS = new Set([
  'yell.com', 'checkatrade.com', '192.com', 'freeindex.co.uk',
  'thomsonlocal.com', 'trustatrader.com', 'ratedpeople.com',
  'threebestrated.co.uk', 'housejester.com', 'realpeoplemedia.co.uk',
  'bark.com', 'mybuilder.com', 'rated.co.uk', 'tradesman.io',
  'outrank.co.uk', 'drivingschoolfinder.co.uk', 'getcarclean.com',
  'schoolatlas.co.uk', 'newlifeteeth.co.uk',
]);

// Web agency categories — never prospects, never enrich
const WEB_AGENCY_CATEGORIES = new Set([
  'web developer', 'web designer', 'website designer', 'seo consultant',
  'it consultant', 'it support', 'app developer', 'software company',
  'digital marketing agency', 'marketing consultant',
  'internet marketing service', 'graphic designer',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalisePhone(p) {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  if (digits.startsWith('440')) return '0' + digits.slice(2);
  if (digits.startsWith('44'))  return '0' + digits.slice(2);
  return digits;
}

function phonesMatch(a, b) {
  const na = normalisePhone(a);
  const nb = normalisePhone(b);
  if (!na || !nb || na.length < 9 || nb.length < 9) return false;
  return na.slice(-10) === nb.slice(-10);
}

function normalisePostcode(pc) {
  return (pc || '').toUpperCase().replace(/\s+/g, '');
}

function extractEmails(text) {
  if (!text) return [];
  // Unescape HTML entities before scanning so we don't pick up u003einfo@... artifacts
  const clean = text
    .replace(/\\u003e/gi, '').replace(/&gt;/gi, '').replace(/&#62;/gi, '')
    .replace(/\\u003c/gi, '').replace(/&lt;/gi, '').replace(/&#60;/gi, '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"');
  const re = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
  const found = [];
  for (const m of clean.matchAll(re)) {
    const email = m[1].toLowerCase();
    if (!isEmailJunk(email)) found.push(email);
  }
  return [...new Set(found)];
}

function isEmailJunk(email) {
  const domain = email.split('@')[1] || '';
  if (EMAIL_JUNK_DOMAINS.has(domain)) return true;
  if ([...EMAIL_JUNK_DOMAINS].some(junk => domain.endsWith('.' + junk))) return true;
  if (/\.(png|jpg|gif|svg|css|js|woff|ico|php)$/i.test(email)) return true;
  if (email.length > 100 || email.includes('..')) return true;
  // Placeholder patterns
  if (/^(name|your|you|info|email|test|user|admin|contact|hello|noreply|no-reply)@(your|my|a|the|site|domain|example|website|company)\./i.test(email)) return true;
  // Garbage short domains (e.g. m@z.ib, t-k@f.tf, w@7.wj)
  const tld = domain.split('.').pop();
  const sld = domain.split('.').slice(-2, -1)[0] || '';
  if (sld.length <= 2 || tld.length <= 2) return true;
  return false;
}

function isBlockedDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return BLOCKED_DOMAINS.has(host) || [...BLOCKED_DOMAINS].some(b => host.endsWith('.' + b));
  } catch { return false; }
}

async function fetchHtml(url, timeoutMs = 7000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return res.text();
  } catch { return null; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Serper search ───────────────────────────────────────────────────────────

async function googleSearch(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];

  try {
    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'gb', hl: 'en', num: 10 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log(`    [serper] API error ${res.status}: ${await res.text()}`);
      return [];
    }
    const data = await res.json();
    return (data.organic || []).map(r => ({ title: r.title, link: r.link, snippet: r.snippet }));
  } catch (err) {
    console.log(`    [serper] fetch error: ${err.message}`);
    return [];
  }
}

// Consumer email domains — a gmail/hotmail etc. address can belong to any business
const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com',
  'outlook.co.uk', 'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk',
  'icloud.com', 'me.com', 'mac.com', 'btinternet.com', 'sky.com',
  'talktalk.net', 'virginmedia.com', 'ntlworld.com', 'aol.com', 'aol.co.uk',
  'protonmail.com', 'pm.me',
]);

// Confidence that a result belongs to this specific business
function assessConfidence(text, businessName, phone, postcode, emailDomain) {
  const phoneFound = phone && phonesMatch(phone, text.replace(/\s/g, ''));
  if (phoneFound) return 'high';

  const pc = normalisePostcode(postcode);
  const postcodeFound = pc.length >= 5 && text.toUpperCase().includes(pc.slice(0, -2));
  // Match first meaningful word — skip stop-words that cause false matches
  const words = businessName.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !['the','and','for','ltd','with'].includes(w));
  const nameFound = words.length > 0 && words.some(w => text.toLowerCase().includes(w));

  if (!nameFound || !postcodeFound) return 'low';

  // For non-consumer domains, verify the domain plausibly relates to the business name.
  // If the email is info@acme-plumbing.com but we're searching "Bob's Flowers", reject it.
  if (emailDomain && !CONSUMER_EMAIL_DOMAINS.has(emailDomain)) {
    const domainWords = emailDomain.replace(/\.(com|co\.uk|uk|net|org|io)$/, '').split(/[-_.]+/);
    const bizWords = businessName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const domainMatchesBiz = domainWords.some(dw => dw.length > 3 && bizWords.some(bw => bw.includes(dw) || dw.includes(bw)));
    if (!domainMatchesBiz) return 'low';
  }

  return 'medium';
}

// ─── Strategy 0 (Dark cohort only): search by domain ─────────────────────────
// The business has a registered domain — search it directly to find any listed email.

async function searchByDomain(domain, businessName, phone, postcode) {
  if (!domain) return null;

  // Strip common prefixes for a clean domain search
  const bare = domain.replace(/^www\./, '');
  const results = await googleSearch(`"${bare}" email contact`);

  for (const item of results) {
    if (isBlockedDomain(item.link)) continue;

    const combinedText = `${item.snippet || ''} ${item.title || ''}`;
    const snippetEmails = extractEmails(combinedText);
    if (snippetEmails.length) {
      const emailDomain = snippetEmails[0].split('@')[1];
      const confidence = assessConfidence(combinedText, businessName, phone, postcode, emailDomain);
      if (confidence !== 'low') {
        console.log(`    [cse] Domain search found in snippet: ${snippetEmails[0]} [${confidence}]`);
        return { email: snippetEmails[0], confidence, source: 'serper', profileUrl: item.link };
      }
    }

    if (!isBlockedDomain(item.link)) {
      const html = await fetchHtml(item.link);
      if (!html) continue;
      const pageEmails = extractEmails(html);
      if (pageEmails.length) {
        const emailDomain = pageEmails[0].split('@')[1];
        const pageConfidence = assessConfidence(html, businessName, phone, postcode, emailDomain);
        if (pageConfidence !== 'low') {
          console.log(`    [cse] Domain search found on page: ${pageEmails[0]} [${pageConfidence}]`);
          return { email: pageEmails[0], confidence: pageConfidence, source: 'serper', profileUrl: item.link };
        }
      }
    }

    await sleep(200);
  }

  return null;
}

// ─── Strategy 1: Search by phone number ──────────────────────────────────────

async function searchByPhone(phone, businessName) {
  if (!phone) return null;

  const norm = normalisePhone(phone);
  const withSpace = norm.replace(/^0(\d{4})(\d{6})$/, '0$1 $2')
                        .replace(/^0(\d{3})(\d{7})$/, '0$1 $2');
  const queries = [...new Set([phone, norm, withSpace])];

  for (const q of queries) {
    const results = await googleSearch(`"${q}"`);
    if (!results.length) continue;

    for (const item of results) {
      if (isBlockedDomain(item.link)) continue;

      const combinedText = `${item.snippet || ''} ${item.title || ''}`;
      const emails = extractEmails(combinedText);
      if (emails.length) {
        console.log(`    [cse] Phone search found email in snippet: ${emails[0]}`);
        return { email: emails[0], confidence: 'high', source: 'serper', profileUrl: item.link };
      }

      const html = await fetchHtml(item.link);
      if (!html) continue;
      const pageEmails = extractEmails(html);
      if (pageEmails.length) {
        console.log(`    [cse] Phone search found email on page: ${pageEmails[0]}`);
        return { email: pageEmails[0], confidence: 'high', source: 'serper', profileUrl: item.link };
      }
    }
    await sleep(300);
  }

  return null;
}

// ─── Strategy 2: Search by name + location for email ─────────────────────────

async function searchByNameEmail(businessName, location, phone, postcode) {
  const city = location.split(' ').pop();
  const query = `"${businessName}" "${city}" email`;
  const results = await googleSearch(query);

  for (const item of results) {
    if (isBlockedDomain(item.link)) continue;

    const combinedText = `${item.snippet || ''} ${item.title || ''}`;
    const snippetEmails = extractEmails(combinedText);
    if (snippetEmails.length) {
      const emailDomain = snippetEmails[0].split('@')[1];
      const confidence = assessConfidence(combinedText, businessName, phone, postcode, emailDomain);
      if (confidence !== 'low') {
        console.log(`    [cse] Name+email search found in snippet: ${snippetEmails[0]} [${confidence}]`);
        return { email: snippetEmails[0], confidence, source: 'serper', profileUrl: item.link };
      }
    }

    const html = await fetchHtml(item.link);
    if (!html) continue;
    const pageEmails = extractEmails(html);
    if (pageEmails.length) {
      const emailDomain = pageEmails[0].split('@')[1];
      const pageConfidence = assessConfidence(html, businessName, phone, postcode, emailDomain);
      if (pageConfidence !== 'low') {
        console.log(`    [cse] Name+email search found on page: ${pageEmails[0]} [${pageConfidence}]`);
        return { email: pageEmails[0], confidence: pageConfidence, source: 'serper', profileUrl: item.link };
      }
    }

    await sleep(200);
  }

  return null;
}

// ─── Strategy 3: Directory search ────────────────────────────────────────────

async function searchDirectories(businessName, location, phone, postcode) {
  const city = location.split(' ').pop();
  const query = `"${businessName}" "${city}"`;
  const results = await googleSearch(query);

  for (const item of results) {
    if (isBlockedDomain(item.link)) continue;
    if (item.link.includes('facebook.com') || item.link.includes('instagram.com')) {
      // Snippet-only for social — never fetch
      const combinedText = `${item.snippet || ''} ${item.title || ''}`;
      const snippetEmails = extractEmails(combinedText);
      if (snippetEmails.length) {
        const emailDomain = snippetEmails[0].split('@')[1];
        const confidence = assessConfidence(combinedText, businessName, phone, postcode, emailDomain);
        if (confidence !== 'low') {
          console.log(`    [cse] Social snippet: ${snippetEmails[0]} [${confidence}]`);
          return { email: snippetEmails[0], confidence, source: 'facebook', profileUrl: item.link };
        }
      }
      continue;
    }

    const combinedText = `${item.snippet || ''} ${item.title || ''}`;
    const snippetEmails = extractEmails(combinedText);
    if (snippetEmails.length) {
      const emailDomain = snippetEmails[0].split('@')[1];
      const confidence = assessConfidence(combinedText, businessName, phone, postcode, emailDomain);
      if (confidence !== 'low') {
        console.log(`    [cse] Directory search found in snippet: ${snippetEmails[0]} [${confidence}] via ${item.link}`);
        return { email: snippetEmails[0], confidence, source: 'directory', profileUrl: item.link };
      }
    }

    const html = await fetchHtml(item.link);
    if (!html) continue;
    const pageEmails = extractEmails(html);
    if (pageEmails.length) {
      const emailDomain = pageEmails[0].split('@')[1];
      const pageConfidence = assessConfidence(html, businessName, phone, postcode, emailDomain);
      if (pageConfidence !== 'low') {
        const source = item.link.includes('linkedin.com') ? 'linkedin' : 'directory';
        console.log(`    [cse] Directory search found on page: ${pageEmails[0]} [${pageConfidence}] via ${item.link}`);
        return { email: pageEmails[0], confidence: pageConfidence, source, profileUrl: item.link };
      }
    }

    await sleep(200);
  }

  return null;
}

// ─── WHOIS lookup ────────────────────────────────────────────────────────────

export async function lookupWhois(domain) {
  if (!domain) return null;
  const bare = domain.replace(/^www\./, '');

  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(null), 10000);
    whoisLookup(bare, (err, data) => {
      clearTimeout(timeout);
      if (err || !data) return resolve(null);

      const result = {};

      // Registrar
      const registrar = data.match(/Registrar:\s*\n\s*([^\n[]+)/i)?.[1]?.trim()
        || data.match(/Registrar:\s*(.+)/i)?.[1]?.trim();
      if (registrar) result.registrar = registrar;

      // Dates — Nominet format
      const registered = data.match(/Registered on:\s*(.+)/i)?.[1]?.trim();
      const expiry     = data.match(/Expiry date:\s*(.+)/i)?.[1]?.trim();
      // ICANN format
      const created    = data.match(/Creation Date:\s*(.+)/i)?.[1]?.trim();
      const expires    = data.match(/Registry Expiry Date:\s*(.+)/i)?.[1]?.trim();

      const parseDate = s => {
        if (!s) return null;
        const d = new Date(s);
        return isNaN(d) ? null : d.toISOString().slice(0, 10);
      };

      result.registered_date = parseDate(registered || created);
      result.expiry_date     = parseDate(expiry || expires);

      // Nameservers
      const nsLines = [...data.matchAll(/Name ?[Ss]erver[s]?:\s*(.+)/g)].map(m => m[1].trim().toLowerCase());
      if (nsLines.length) result.nameservers = [...new Set(nsLines)];

      resolve(Object.keys(result).length ? result : null);
    });
  });
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function findEmailFromDirectories(business) {
  const { name, location, phone, postcode, domain, category } = business;

  if (WEB_AGENCY_CATEGORIES.has((category || '').toLowerCase())) {
    console.log(`    [directory-finder] Skipping web agency: ${name}`);
    return null;
  }

  if (!process.env.SERPER_API_KEY) {
    console.log(`    [directory-finder] SERPER_API_KEY not set — skipping enrichment`);
    return null;
  }

  console.log(`    [directory-finder] Searching: ${name} (${location})${phone ? ` [📞 ${phone}]` : ''}${domain ? ` [🌐 ${domain}]` : ''}`);

  const strategies = [
    { label: 'Domain search',    fn: () => searchByDomain(domain, name, phone, postcode), skipIf: !domain },
    { label: 'Phone search',     fn: () => searchByPhone(phone, name),                    skipIf: !phone },
    { label: 'Name+email search', fn: () => searchByNameEmail(name, location, phone, postcode) },
    { label: 'Directory search', fn: () => searchDirectories(name, location, phone, postcode) },
  ];

  for (const { label, fn, skipIf } of strategies) {
    if (skipIf) continue;

    try {
      console.log(`    [directory-finder] Trying ${label}...`);
      const result = await fn();

      if (!result) { console.log(`    [directory-finder] ${label}: no match`); continue; }
      if (result.confidence === 'low') { console.log(`    [directory-finder] ${label}: low confidence — skipping`); continue; }

      console.log(`    [directory-finder] ✓ ${label}: ${result.email} [${result.confidence}]`);
      return result;
    } catch (err) {
      console.log(`    [directory-finder] ${label} error: ${err.message}`);
    }

    await sleep(500);
  }

  console.log(`    [directory-finder] No verified email found for ${name}`);
  return null;
}
