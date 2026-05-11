// Cloudflare Pages Function — GET /api/domain-options?slug={site_slug}
// Checks Porkbun for 3 TLD options for the business and returns availability + price.
// Requires env: PORKBUN_API_KEY, PORKBUN_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

// .co.uk and .com are always shown (available or not)
const FIXED_TLDS = ['.co.uk', '.com'];
// Cycled in order to fill up to 3 additional available slots
const EXTRA_TLDS = ['.uk', '.net', '.org', '.co', '.biz', '.info', '.online'];
const MAX_EXTRA_AVAILABLE = 3;

const PORKBUN = 'https://api.porkbun.com/api/json/v3';
const USD_TO_GBP = 0.79;

export async function onRequestGet(context) {
  const { request, env } = context;
  const slug = new URL(request.url).searchParams.get('slug') || '';

  if (!slug) return json({ error: 'slug required' }, 400);
  if (!env.PORKBUN_API_KEY) return json({ error: 'not configured' }, 500);

  let domainBase = slugToDomainBase(slug);
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    try {
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/businesses?site_slug=eq.${encodeURIComponent(slug)}&select=name&limit=1`,
        { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
      );
      const rows = await r.json();
      if (rows?.[0]?.name) domainBase = nameToDomainBase(rows[0].name);
    } catch { /* fall back to slug-derived base */ }
  }

  async function checkTld(tld) {
    const domain = `${domainBase}${tld}`;
    try {
      const r = await fetch(`${PORKBUN}/domain/checkDomain/${domain}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: env.PORKBUN_API_KEY, secretapikey: env.PORKBUN_SECRET_KEY }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json();
      const avail = data.status === 'SUCCESS' && data.response?.avail === 'yes' && data.response?.premium !== 'yes';
      const priceUsd = avail ? parseFloat(data.response?.price || '10') : null;
      return { domain, tld, available: avail, price_gbp: avail ? roundGbp(priceUsd * USD_TO_GBP) : null, price_usd: priceUsd };
    } catch {
      return { domain, tld, available: false, error: true };
    }
  }

  // Always check and return .co.uk and .com — shown even if unavailable
  const fixedOptions = [];
  for (const tld of FIXED_TLDS) {
    fixedOptions.push(await checkTld(tld));
  }

  // Cycle extra TLDs until we have MAX_EXTRA_AVAILABLE available slots filled
  const extraOptions = [];
  for (const tld of EXTRA_TLDS) {
    if (extraOptions.length >= MAX_EXTRA_AVAILABLE) break;
    const opt = await checkTld(tld);
    if (opt.available) extraOptions.push(opt);
  }

  return json({ domain_base: domainBase, options: [...fixedOptions, ...extraOptions] });
}

function nameToDomainBase(name) {
  return name
    .toLowerCase()
    .replace(/\b(limited|ltd|llp|llc|plc|inc|corp)\b\.?/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 22);
}

function slugToDomainBase(slug) {
  // "bobs-plumbing-bonnington-edinburgh" → strip last 2 location parts → "bobsplumbing"
  const parts = slug.split('-');
  const keep = parts.slice(0, Math.max(parts.length - 2, 2));
  return keep.join('').replace(/[^a-z0-9]/g, '').slice(0, 22);
}

function roundGbp(n) { return Math.round(n * 100) / 100; }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
  });
}
