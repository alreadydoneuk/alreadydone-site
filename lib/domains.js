import 'dotenv/config';

const API_BASE = 'https://api.porkbun.com/api/json/v3';
const API_KEY    = process.env.PORKBUN_API_KEY;
const SECRET_KEY = process.env.PORKBUN_SECRET_KEY;

const PREFERRED_TLDS = ['.co.uk', '.com', '.uk'];

// GitHub Pages IP addresses
const GITHUB_PAGES_IPS = [
  '185.199.108.153',
  '185.199.109.153',
  '185.199.110.153',
  '185.199.111.153',
];

function auth() {
  return { apikey: API_KEY, secretapikey: SECRET_KEY };
}

async function porkbun(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...auth(), ...body }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (data.status !== 'SUCCESS') {
    const err = new Error(`Porkbun error: ${data.message || JSON.stringify(data)}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

// Slugify a business name into a valid domain label
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// ─── Availability & Pricing ───────────────────────────────────────────────────

export async function checkDomain(domain) {
  try {
    const data = await porkbun(`/domain/checkDomain/${domain}`);
    const r = data.response;
    const available = r.avail === 'yes' && r.premium === 'no';
    const price = r.price ?? null;
    return { domain, available, priceUsd: price ? parseFloat(price) : null };
  } catch (err) {
    return { domain, available: false, priceUsd: null, error: err.message };
  }
}

// Check the three preferred TLDs for a business name and return all results
export async function getSuggestedDomains(businessName) {
  const slug = slugify(businessName);
  // Sequential to avoid rate-limit (1 check per 10s per account)
  const results = [];
  for (const tld of PREFERRED_TLDS) {
    results.push(await checkDomain(`${slug}${tld}`));
  }
  return results;
}

// Return the best available domain for a business: .co.uk first, then .com, then .uk
export async function getBestDomain(businessName) {
  const options = await getSuggestedDomains(businessName);
  return options.find(o => o.available) || null;
}

// ─── Registration ─────────────────────────────────────────────────────────────

// Register a domain. Requires a prior checkDomain call to get the exact price.
// cost is in USD dollars (we convert to pennies). agreeToTerms is mandatory.
// WHOIS privacy is enabled by default on Porkbun accounts.
export async function registerDomain(domain, { costUsd } = {}) {
  if (!costUsd) {
    const check = await checkDomain(domain);
    if (!check.available) throw new Error(`${domain} is not available`);
    costUsd = check.priceUsd;
  }
  const costPennies = Math.round(costUsd * 100);
  const data = await porkbun(`/domain/create/${domain}`, {
    cost: costPennies,
    agreeToTerms: 'yes',
  });
  console.log(`[domains] Registered ${domain} — order ${data.orderId}`);
  return { domain, registered: true, orderId: data.orderId, costUsd };
}

// ─── DNS management ───────────────────────────────────────────────────────────

export async function getDnsRecords(domain) {
  const data = await porkbun(`/dns/retrieve/${domain}`);
  return data.records || [];
}

export async function addDnsRecord(domain, { type, name, content, ttl = 600, prio = 0 }) {
  await porkbun(`/dns/create/${domain}`, { type, name, content, ttl, prio });
  console.log(`[domains] DNS ${type} record added to ${domain}: ${name || '@'} → ${content}`);
}

export async function deleteDnsRecordsByType(domain, type, subdomain = '') {
  await porkbun(`/dns/deleteByNameType/${domain}/${type}/${subdomain}`);
  console.log(`[domains] Deleted ${type} records on ${domain} (subdomain: "${subdomain}")`);
}

// Point a domain at a Cloudflare Pages deployment.
// Sets CNAME @ → pages-hostname (e.g. my-site.pages.dev)
export async function pointToCloudflarePages(domain, pagesHostname) {
  await deleteDnsRecordsByType(domain, 'A', '').catch(() => {});
  await deleteDnsRecordsByType(domain, 'CNAME', '').catch(() => {});
  await addDnsRecord(domain, { type: 'CNAME', name: '', content: pagesHostname, ttl: 600 });

  await deleteDnsRecordsByType(domain, 'CNAME', 'www').catch(() => {});
  await addDnsRecord(domain, { type: 'CNAME', name: 'www', content: pagesHostname, ttl: 600 });

  console.log(`[domains] ${domain} → ${pagesHostname} (root + www)`);
}

// Point a domain at GitHub Pages.
// githubUser: the GitHub username (e.g. "imthebus")
export async function pointToGitHubPages(domain, githubUser) {
  await deleteDnsRecordsByType(domain, 'A', '').catch(() => {});
  await deleteDnsRecordsByType(domain, 'CNAME', '').catch(() => {});

  for (const ip of GITHUB_PAGES_IPS) {
    await addDnsRecord(domain, { type: 'A', name: '', content: ip, ttl: 600 });
  }

  await deleteDnsRecordsByType(domain, 'CNAME', 'www').catch(() => {});
  await addDnsRecord(domain, {
    type: 'CNAME',
    name: 'www',
    content: `${githubUser}.github.io`,
    ttl: 600,
  });

  console.log(`[domains] ${domain} → GitHub Pages (${githubUser}.github.io)`);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export async function ping() {
  const data = await porkbun('/ping');
  return data.yourIp;
}

// Poll a domain until it returns HTTP 200 — gates Email 2 in provisionProspect.
// Resolves true when live, false if max attempts exhausted.
export async function pollUntilLive(domain, { maxAttempts = 30, intervalMs = 60000 } = {}) {
  const url = `https://${domain}`;
  console.log(`[poll] Waiting for ${url} to return 200 (max ${maxAttempts} attempts)...`);

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        console.log(`[poll] ${url} is live (attempt ${i})`);
        return true;
      }
      console.log(`[poll] Attempt ${i}/${maxAttempts} — got ${res.status}, retrying in ${intervalMs / 1000}s`);
    } catch (err) {
      console.log(`[poll] Attempt ${i}/${maxAttempts} — ${err.message}, retrying in ${intervalMs / 1000}s`);
    }
    if (i < maxAttempts) await new Promise(r => setTimeout(r, intervalMs));
  }

  console.log(`[poll] ${url} did not come up after ${maxAttempts} attempts`);
  return false;
}

export { slugify };
