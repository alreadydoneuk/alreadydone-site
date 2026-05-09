// Cloudflare Pages Function — POST /api/create-checkout
// Creates a Stripe Checkout Session for the selected options and returns {url}.
// Body (JSON): { slug, tier, domain, domain_price_gbp, pages, email_count, email_prefixes, include_report }
//   pages: [{ type, copy, edit_level, has_images, has_pdf }]
//   email_count: number of email addresses (0 = none)
//   email_prefixes: array of strings e.g. ['info', 'hello']
//   include_report: boolean

const STRIPE_API = 'https://api.stripe.com/v1';

const TIER_PRICES = { '99': 9900, '179': 17900, '249': 24900 };
const TIER_NAMES  = {
  '99':  'One-page website',
  '179': 'Multi-page website (About + 1 extra page)',
  '249': 'Website with gallery (About, extra page, gallery)',
};
const PAGE_PRICE_PENCE = 5000;  // £50
const EMAIL_FIRST_PENCE = 2400; // £24/yr
const EMAIL_EXTRA_PENCE = 1200; // £12/yr each
const REPORT_PRICE_PENCE = 500; // £5/mo — flagged in metadata, not a Stripe subscription item here

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Stripe not configured — contact dean@alreadydone.uk' }, 503);
  }

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const { slug, tier, domain, domain_price_gbp, pages = [], email_count = 0, email_prefixes = [], include_report = false } = body;
  if (!slug || !tier) return json({ error: 'slug and tier required' }, 400);

  // Look up business email for pre-filling Stripe checkout
  let customerEmail = null;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    try {
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/businesses?site_slug=eq.${encodeURIComponent(slug)}&select=email&limit=1`,
        { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
      );
      const rows = await r.json();
      customerEmail = rows?.[0]?.email || null;
    } catch { /* no email pre-fill */ }
  }

  // Build Stripe line items
  const lineItems = [];
  let idx = 0;

  // Site tier
  const tierKey = String(tier);
  if (!TIER_PRICES[tierKey]) return json({ error: 'Invalid tier' }, 400);
  lineItems.push({
    name: TIER_NAMES[tierKey],
    amount: TIER_PRICES[tierKey],
    qty: 1,
  });
  idx++;

  // Domain
  if (domain && domain_price_gbp) {
    const domainPence = Math.round(parseFloat(domain_price_gbp) * 100);
    lineItems.push({ name: `Domain: ${domain} (1 year)`, amount: domainPence, qty: 1 });
  }

  // Extra pages
  const validPages = (pages || []).filter(p => p && p.type);
  for (const page of validPages) {
    lineItems.push({ name: `Extra page: ${page.type}`, amount: PAGE_PRICE_PENCE, qty: 1 });
  }

  // Email addresses
  if (email_count >= 1) {
    lineItems.push({ name: `Business email address (1 year)`, amount: EMAIL_FIRST_PENCE, qty: 1 });
  }
  if (email_count >= 2) {
    lineItems.push({ name: `Additional email address${email_count > 2 ? 'es' : ''} (1 year)`, amount: EMAIL_EXTRA_PENCE, qty: email_count - 1 });
  }

  // Build Stripe session payload (form-encoded)
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('client_reference_id', slug);
  params.set('success_url', `https://alreadydone.uk/checkout/success?session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `https://alreadydone.uk/checkout?slug=${encodeURIComponent(slug)}`);
  if (customerEmail) params.set('customer_email', customerEmail);

  lineItems.forEach((item, i) => {
    params.set(`line_items[${i}][price_data][currency]`, 'gbp');
    params.set(`line_items[${i}][price_data][unit_amount]`, String(item.amount));
    params.set(`line_items[${i}][price_data][product_data][name]`, item.name);
    params.set(`line_items[${i}][quantity]`, String(item.qty));
  });

  // Metadata: everything the webhook needs to provision the order
  params.set('metadata[slug]', slug);
  params.set('metadata[tier]', tierKey);
  params.set('metadata[domain]', domain || '');
  params.set('metadata[domain_price_gbp]', String(domain_price_gbp || 0));
  params.set('metadata[email_count]', String(email_count));
  if (email_prefixes.length) {
    params.set('metadata[email_prefixes]', JSON.stringify(email_prefixes.slice(0, 5)));
  }
  params.set('metadata[include_report]', String(include_report));
  if (validPages.length) {
    params.set('metadata[pages]', JSON.stringify(validPages.map(p => ({
      type: p.type,
      edit_level: p.edit_level || 'verbatim',
      copy: (p.copy || '').slice(0, 400), // Stripe metadata limit
    }))));
  }

  const stripeRes = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const session = await stripeRes.json();
  if (!stripeRes.ok) {
    console.error('Stripe error:', session.error?.message);
    return json({ error: session.error?.message || 'Stripe error' }, 502);
  }

  return json({ url: session.url });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
