// Cloudflare Pages Function — GET /api/domain-options?slug={site_slug}
// Availability checked via RDAP (public, no auth, parallel — no rate limit).
// 404 = available, 200 = registered/taken.
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const FIXED_TLDS = ['.co.uk', '.com'];
const EXTRA_TLDS = ['.uk', '.net', '.org', '.co', '.biz', '.info', '.online'];
const MAX_EXTRA_AVAILABLE = 3;

// RDAP bootstrap servers per TLD
const RDAP = {
  'co.uk':  'https://rdap.nominet.uk/uk/domain/',
  'uk':     'https://rdap.nominet.uk/uk/domain/',
  'com':    'https://rdap.verisign.com/com/v1/domain/',
  'net':    'https://rdap.verisign.com/net/v1/domain/',
  'org':    'https://rdap.pir.org/domain/',
  'co':     'https://rdap.nic.co/domain/',
  'biz':    'https://rdap.nic.biz/domain/',
  'info':   'https://rdap.afilias.net/domain/',
  'online': 'https://rdap.nic.online/domain/',
};

const PRICES_GBP = {
  '.co.uk':  6.70,
  '.com':    8.67,
  '.uk':     4.96,
  '.net':    9.89,
  '.org':    9.09,
  '.co':     9.49,
  '.biz':    9.49,
  '.info':   9.09,
  '.online': 3.99,
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const slug = new URL(request.url).searchParams.get('slug') || '';

  if (!slug) return json({ error: 'slug required' }, 400);

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
    const tldKey = tld.replace(/^\./, '');
    const rdapBase = RDAP[tldKey];
    if (!rdapBase) return { domain, tld, available: false };
    try {
      const r = await fetch(`${rdapBase}${domain}`, {
        headers: { Accept: 'application/rdap+json' },
        signal: AbortSignal.timeout(6000),
      });
      const available = r.status === 404;
      return { domain, tld, available, price_gbp: available ? (PRICES_GBP[tld] ?? null) : null };
    } catch {
      return { domain, tld, available: false, error: true };
    }
  }

  // All checks in parallel — no rate limit with RDAP
  const [fixedOptions, extraChecked] = await Promise.all([
    Promise.all(FIXED_TLDS.map(checkTld)),
    Promise.all(EXTRA_TLDS.map(checkTld)),
  ]);

  const extraOptions = extraChecked.filter(o => o.available).slice(0, MAX_EXTRA_AVAILABLE);

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
  const parts = slug.split('-');
  const keep = parts.slice(0, Math.max(parts.length - 2, 2));
  return keep.join('').replace(/[^a-z0-9]/g, '').slice(0, 22);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
  });
}
