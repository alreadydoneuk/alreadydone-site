// Cloudflare Pages Function — /api/stripe-webhook
// Receives Stripe checkout.session.completed events, marks the business as paid,
// and fires a Slack alert so Dean can monitor revenue.
// Provisioning (domain registration, site deploy, onboarding email) is handled
// by the provision-agent.js cron job which polls for pipeline_status = 'paid'.

export async function onRequestPost(context) {
  const { request, env } = context;

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    return new Response('Stripe not configured', { status: 500 });
  }

  // Verify Stripe signature
  let event;
  try {
    event = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`Webhook signature invalid: ${err.message}`, { status: 400 });
  }

  if (event.type !== 'checkout.session.completed') {
    return new Response('OK', { status: 200 });
  }

  const session = event.data.object;
  const slug = session.client_reference_id;
  const customerEmail = session.customer_details?.email;
  const customerFullName = session.customer_details?.name || '';
  const customerFirstName = customerFullName.split(' ')[0] || null;
  const amountPence = session.amount_total;
  const currency = session.currency?.toUpperCase() || 'GBP';

  if (!slug) {
    console.error('No client_reference_id on session:', session.id);
    return new Response('OK', { status: 200 });
  }

  // Look up business by site_slug — include stripe_session_id and pipeline_status for idempotency checks
  const businessRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/businesses?site_slug=eq.${encodeURIComponent(slug)}&select=id,name,category,location,email,stripe_session_id,pipeline_status&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const businesses = await businessRes.json();
  const business = businesses?.[0];

  if (!business) {
    console.error('No business found for slug:', slug);
    await slackAlert(env, `⚠️ Stripe payment received but no business found for slug: \`${slug}\`\nSession: ${session.id}`);
    return new Response('OK', { status: 200 });
  }

  // Idempotency guard — Stripe retries if we don't respond quickly enough.
  // If we already recorded this session, return OK without re-processing.
  if (business.stripe_session_id === session.id) {
    console.log('Duplicate webhook for session', session.id, '— already processed, skipping');
    return new Response('OK', { status: 200 });
  }

  // Guard against re-processing already-provisioned orders.
  // pipeline_status beyond 'paid' means provision has started or completed.
  const alreadyProvisioning = ['delivering', 'delivered'].includes(business.pipeline_status);
  if (alreadyProvisioning) {
    console.log('Business already provisioning/delivered — ignoring duplicate webhook');
    return new Response('OK', { status: 200 });
  }

  // Extract order metadata from session
  const meta = session.metadata || {};
  const orderDomain = meta.domain || null;
  const orderTier = parseInt(meta.tier || '99');
  const orderEmailCount = parseInt(meta.email_count || '0');
  const orderEmailPrefixes = meta.email_prefixes ? meta.email_prefixes : null;
  const orderIncludeReport = meta.include_report === 'true';
  const orderPages = meta.pages ? JSON.parse(meta.pages) : [];

  // Mark as paid with full order detail
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/businesses?id=eq.${business.id}`,
    {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        pipeline_status: 'paid',
        paid_at: new Date().toISOString(),
        stripe_session_id: session.id,
        customer_email: customerEmail || business.email,
        customer_first_name: customerFirstName,
        order_domain: orderDomain,
        order_tier: orderTier,
        order_email_count: orderEmailCount,
        order_email_prefixes: orderEmailPrefixes,
        order_include_report: orderIncludeReport,
        order_pages: orderPages.length ? JSON.stringify(orderPages) : null,
      }),
    }
  );

  // Record revenue in finance table — this is what finance-agent reads for P&L reports
  const amountGbp = amountPence ? amountPence / 100 : 0;
  const taxYear = new Date().getFullYear().toString();
  const financeDescription = [
    `${business.name}`,
    orderDomain ? `domain: ${orderDomain}` : null,
    orderEmailCount > 0 ? `${orderEmailCount} email(s)` : null,
  ].filter(Boolean).join(' — ');

  await fetch(
    `${env.SUPABASE_URL}/rest/v1/finance`,
    {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        business_id: business.id,
        type: 'revenue',
        category: 'website_sale',
        amount: amountGbp,
        currency: currency,
        description: financeDescription,
        stripe_payment_id: session.id,
        tax_year: taxYear,
      }),
    }
  );

  // Log interaction
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/interactions`,
    {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        business_id: business.id,
        type: 'payment_received',
        direction: 'inbound',
        content_summary: `Payment of ${amountPence / 100} ${currency} received via Stripe`,
        metadata: { stripe_session_id: session.id, customer_email: customerEmail, amount_pence: amountPence },
      }),
    }
  );

  // Slack revenue alert
  const amount = amountPence ? `£${(amountPence / 100).toFixed(2)}` : '£99';
  const orderSummary = [
    `Tier: £${orderTier}`,
    orderDomain ? `Domain: ${orderDomain}` : null,
    orderEmailCount > 0 ? `${orderEmailCount} email addr` : null,
    orderIncludeReport ? 'Report add-on' : null,
    orderPages.length > 0 ? `${orderPages.length} extra page(s)` : null,
  ].filter(Boolean).join(' · ');

  await slackAlert(
    env,
    `💳 *Payment received — ${amount}*\n${business.name} (${business.category}, ${business.location})\n${orderSummary}\n_Provisioning queued — site goes live within the hour_`,
    'revenue'
  );

  return new Response('OK', { status: 200 });
}

async function slackAlert(env, text, channel = 'pipeline') {
  const webhookKey = channel === 'revenue' ? 'SLACK_REVENUE' : 'SLACK_PIPELINE';
  const url = env[webhookKey];
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

// Minimal Stripe webhook signature verification using Web Crypto API (available in Cloudflare Workers)
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) throw new Error('Missing stripe-signature header');

  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const signature = parts.v1;

  if (!timestamp || !signature) throw new Error('Malformed stripe-signature header');

  // Replay attack prevention — reject if older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) throw new Error(`Timestamp too old: ${Math.round(age)}s`);

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (expected !== signature) throw new Error('Signature mismatch');

  return JSON.parse(payload);
}
