// Cloudflare Pages Function — /api/checkout-event
// Receives checkout funnel events from the browser and records them to Supabase.
// Fire-and-forget from the frontend — always returns 200.

export async function onRequestPost(context) {
  const { request, env } = context;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const { event, slug, metadata = {} } = await request.json();

    if (!event || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
      return new Response('{}', { status: 200, headers: cors });
    }

    const VALID_EVENTS = ['checkout_viewed', 'checkout_domain_selected', 'checkout_payment_started'];
    if (!VALID_EVENTS.includes(event)) {
      return new Response('{}', { status: 200, headers: cors });
    }

    // Look up business by slug to get the ID
    let businessId = null;
    if (slug) {
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/businesses?select=id&site_slug=eq.${encodeURIComponent(slug)}&limit=1`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          },
        }
      );
      const rows = await res.json();
      businessId = rows?.[0]?.id || null;
    }

    // Only record if we can link to a business
    if (!businessId) {
      return new Response('{}', { status: 200, headers: cors });
    }

    await fetch(`${env.SUPABASE_URL}/rest/v1/interactions`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        business_id: businessId,
        type: event,
        direction: 'inbound',
        content_summary: `Checkout: ${event.replace('checkout_', '').replace(/_/g, ' ')}`,
        metadata,
      }),
    });
  } catch (_) {
    // Silently swallow — never error to the client
  }

  return new Response('{}', { status: 200, headers: cors });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
