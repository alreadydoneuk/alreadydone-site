// Cloudflare Pages Function — /api/admin-data
// Returns dashboard JSON for the admin page.
// Protected by a simple bearer token (env.ADMIN_TOKEN).

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-admin-token');

  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sb = (path, params = '') =>
    fetch(`${env.SUPABASE_URL}/rest/v1/${path}${params}`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
    }).then(r => r.json());

  const sbCount = async (path, params = '') => {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}?select=id&limit=1${params ? '&' + params : ''}`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    });
    const cr = r.headers.get('Content-Range') || '0/0';
    return parseInt(cr.split('/')[1]) || 0;
  };

  const [
    pipelineCounts,
    previews,
    paying,
    live,
    recentInteractions,
    revRows,
    totalEmailed,
    totalOpened,
    totalClicked,
    totalReplied,
    checkoutViewed,
    checkoutDomainSelected,
    checkoutPaymentStarted,
  ] = await Promise.all([
    // Pipeline status breakdown (prospects only)
    sb('businesses', '?select=pipeline_status&is_prospect=eq.true'),

    // Preview sites in pipeline — includes engagement columns
    sb('businesses', [
      '?select=id,name,category,location,pipeline_status,preview_url,site_slug,',
      'google_rating,review_count,first_email_sent_at,last_reply_at,response_sentiment,',
      'email_opened_at,email_link_clicked_at',
      '&pipeline_status=in.(template_built,emailed,follow_up_sent,engaged,nurturing,payment_pending)',
      '&preview_url=not.is.null',
      '&order=first_email_sent_at.desc.nullslast',
      '&limit=100',
    ].join('')),

    // Paying customers (paid + delivering — not yet live)
    sb('businesses', [
      '?select=id,name,category,location,pipeline_status,registered_domain,',
      'paid_at,delivered_at,customer_email,order_tier,order_email_count',
      '&pipeline_status=in.(paid,delivering)',
      '&order=paid_at.desc',
      '&limit=50',
    ].join('')),

    // Live sites (delivered) — kept for 2 weeks post-delivery
    sb('businesses', [
      '?select=id,name,category,location,pipeline_status,registered_domain,site_slug,',
      'paid_at,delivered_at,customer_email,order_tier,phone',
      '&pipeline_status=eq.delivered',
      '&order=delivered_at.desc',
      '&limit=50',
    ].join('')),

    // Recent interactions with business name
    sb('interactions', [
      '?select=type,direction,content_summary,created_at,businesses(name,category,location,site_slug)',
      '&order=created_at.desc',
      '&limit=30',
    ].join('')),

    // Revenue from finance table
    sb('finance', '?select=amount&type=eq.revenue'),

    // Email engagement counts
    sbCount('businesses', 'first_email_sent_at=not.is.null'),
    sbCount('businesses', 'email_opened_at=not.is.null'),
    sbCount('businesses', 'email_link_clicked_at=not.is.null'),
    sbCount('businesses', 'last_reply_at=not.is.null'),

    // Checkout funnel from interactions
    sbCount('interactions', 'type=eq.checkout_viewed'),
    sbCount('interactions', 'type=eq.checkout_domain_selected'),
    sbCount('interactions', 'type=eq.checkout_payment_started'),
  ]);

  // Pipeline status counts
  const counts = {};
  for (const row of (pipelineCounts || [])) {
    const s = row.pipeline_status || 'null';
    counts[s] = (counts[s] || 0) + 1;
  }

  // Revenue from finance table
  const grossGbp = (revRows || []).reduce((s, r) => s + parseFloat(r.amount || 0), 0);

  const revenue = {
    gross_gbp: Math.round(grossGbp * 100) / 100,
    total_paid: (paying || []).length,
    total_delivered: (live || []).length,
  };

  const engagement = {
    total_emailed: totalEmailed,
    total_opened: totalOpened,
    total_clicked: totalClicked,
    total_replied: totalReplied,
    open_rate:  totalEmailed > 0 ? Math.round(totalOpened  / totalEmailed * 100) : 0,
    click_rate: totalEmailed > 0 ? Math.round(totalClicked / totalEmailed * 100) : 0,
    reply_rate: totalEmailed > 0 ? Math.round(totalReplied / totalEmailed * 100) : 0,
  };

  const checkout_funnel = {
    viewed:           checkoutViewed,
    domain_selected:  checkoutDomainSelected,
    payment_started:  checkoutPaymentStarted,
    completed:        revenue.total_paid + revenue.total_delivered,
    abandoned:        Math.max(0, checkoutPaymentStarted - (revenue.total_paid + revenue.total_delivered)),
  };

  return new Response(JSON.stringify({
    generated_at: new Date().toISOString(),
    pipeline_counts: counts,
    previews: previews || [],
    paying: paying || [],
    live: live || [],
    recent_interactions: recentInteractions || [],
    revenue,
    engagement,
    checkout_funnel,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
