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

  // Fetch all the data in parallel
  const [pipelineCounts, previews, paying, recentInteractions] = await Promise.all([
    // Status counts
    sb('businesses', '?select=pipeline_status&is_prospect=eq.true'),

    // Preview sites (emailed or replied, has a preview URL)
    sb('businesses', [
      '?select=id,name,category,location,pipeline_status,preview_url,site_slug,',
      'google_rating,review_count,emailed_at,last_reply_at,response_sentiment',
      '&pipeline_status=in.(template_built,emailed,follow_up_sent,replied_positive,replied_negative,replied_neutral)',
      '&preview_url=not.is.null',
      '&order=emailed_at.desc.nullslast',
      '&limit=100',
    ].join('')),

    // Paying / delivered customers
    sb('businesses', [
      '?select=id,name,category,location,pipeline_status,registered_domain,',
      'paid_at,delivered_at,customer_email,stripe_session_id',
      '&pipeline_status=in.(paid,delivering,delivered)',
      '&order=paid_at.desc',
      '&limit=50',
    ].join('')),

    // Recent interactions
    sb('interactions', [
      '?select=type,direction,content_summary,created_at,business_id',
      '&order=created_at.desc',
      '&limit=30',
    ].join('')),
  ]);

  // Aggregate pipeline counts
  const counts = {};
  for (const row of (pipelineCounts || [])) {
    const s = row.pipeline_status || 'null';
    counts[s] = (counts[s] || 0) + 1;
  }

  const revenue = {
    total_paid: (paying || []).filter(b => b.pipeline_status !== 'delivered').length,
    total_delivered: (paying || []).filter(b => b.pipeline_status === 'delivered').length,
    gross_gbp: (paying || []).length * 99,
  };

  return new Response(JSON.stringify({
    generated_at: new Date().toISOString(),
    pipeline_counts: counts,
    previews: previews || [],
    paying: paying || [],
    recent_interactions: recentInteractions || [],
    revenue,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
