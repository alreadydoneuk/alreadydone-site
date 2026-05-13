// Cloudflare Pages Function — /api/admin-data
// Returns full dashboard JSON for all admin tabs.
// Protected by a simple bearer token (env.ADMIN_TOKEN).

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-admin-token');

  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
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
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}?select=id&limit=1${params ? '&' + params : ''}`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          Prefer: 'count=exact',
          Range: '0-0',
        },
      }
    );
    const cr = r.headers.get('Content-Range') || '0/0';
    return parseInt(cr.split('/')[1]) || 0;
  };

  const [
    totalEmailed,
    totalOpened,
    totalClicked,
    totalReplied,
    buildPool,
    enrichQueue,
    excludedCount,
    totalBusinesses,
    checkoutViewed,
    checkoutDomainSelected,
    checkoutPaymentStarted,
    hotCount,
    warmCount,
    coldCount,
    pipelineRows,
    templateBuilt,
    emailedPipeline,
    hotQueue,
    warmQueue,
    enrichmentRecent,
    paying,
    live,
    recentInteractions,
    revRows,
    tokenUsage,
  ] = await Promise.all([
    sbCount('businesses', 'first_email_sent_at=not.is.null'),
    sbCount('businesses', 'email_opened_at=not.is.null'),
    sbCount('businesses', 'email_link_clicked_at=not.is.null'),
    sbCount('businesses', 'last_reply_at=not.is.null'),
    sbCount('businesses', 'pipeline_status=eq.researched&email=not.is.null'),
    sbCount('businesses', 'website_status=in.(none,social)&serper_attempted_at=is.null&email=is.null'),
    sbCount('businesses', 'pipeline_status=eq.excluded'),
    sbCount('businesses', ''),
    sbCount('interactions', 'type=eq.checkout_viewed'),
    sbCount('interactions', 'type=eq.checkout_domain_selected'),
    sbCount('interactions', 'type=eq.checkout_payment_started'),
    sbCount('businesses', 'lead_temperature=eq.hot&pipeline_status=neq.excluded'),
    sbCount('businesses', 'lead_temperature=eq.warm&pipeline_status=neq.excluded'),
    sbCount('businesses', 'lead_temperature=eq.cold&pipeline_status=neq.excluded'),

    sb('businesses', '?select=pipeline_status&pipeline_status=not.is.null&limit=10000'),

    sb('businesses', [
      '?select=id,name,category,location,email,lead_temperature,email_type,preview_url,updated_at',
      '&pipeline_status=eq.template_built',
      '&order=updated_at.desc&limit=100',
    ].join('')),

    sb('businesses', [
      '?select=id,name,category,location,email,lead_temperature,pipeline_status,preview_url,',
      'first_email_sent_at,email_opened_at,email_link_clicked_at,last_reply_at',
      '&pipeline_status=in.(emailed,follow_up_sent,engaged,nurturing,payment_pending)',
      '&order=first_email_sent_at.desc.nullslast&limit=100',
    ].join('')),

    sb('businesses', [
      '?select=id,name,category,location,email,email_confidence,email_source',
      '&pipeline_status=eq.researched&lead_temperature=eq.hot&email=not.is.null',
      '&order=created_at.asc&limit=50',
    ].join('')),

    sb('businesses', [
      '?select=id,name,category,location,email,email_confidence,email_source',
      '&pipeline_status=eq.researched&lead_temperature=eq.warm&email=not.is.null',
      '&order=created_at.asc&limit=50',
    ].join('')),

    sb('businesses', [
      '?select=id,name,email,domain,website_status,pipeline_status,lead_temperature,email_source,updated_at',
      '&serper_attempted_at=not.is.null',
      '&order=updated_at.desc&limit=200',
    ].join('')),

    sb('businesses', [
      '?select=id,name,category,location,pipeline_status,registered_domain,',
      'paid_at,delivered_at,customer_email,order_tier',
      '&pipeline_status=in.(paid,delivering)&order=paid_at.desc&limit=50',
    ].join('')),

    sb('businesses', [
      '?select=id,name,category,location,pipeline_status,registered_domain,site_slug,',
      'paid_at,delivered_at,customer_email,order_tier,phone',
      '&pipeline_status=eq.delivered&order=delivered_at.desc&limit=50',
    ].join('')),

    sb('interactions', [
      '?select=type,direction,content_summary,created_at,businesses(name,category,location)',
      '&order=created_at.desc&limit=50',
    ].join('')),

    sb('finance', '?select=amount&type=eq.revenue'),
    sb('token_usage', '?select=model,input_tokens,output_tokens'),
  ]);

  const pipelineCountMap = {};
  for (const row of (pipelineRows || [])) {
    const s = row.pipeline_status;
    pipelineCountMap[s] = (pipelineCountMap[s] || 0) + 1;
  }

  let totalUsd = 0;
  for (const row of (tokenUsage || [])) {
    const isHaiku = (row.model || '').includes('haiku');
    totalUsd += (row.input_tokens / 1e6) * (isHaiku ? 0.80 : 3.00)
              + (row.output_tokens / 1e6) * (isHaiku ? 4.00 : 15.00);
  }
  const totalGbp   = totalUsd * 0.79;
  const grossGbp   = (revRows || []).reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const totalDelivered = (live || []).length;
  const totalPaid      = (paying || []).length;
  const sent = totalEmailed || 0;

  return new Response(JSON.stringify({
    generated_at: new Date().toISOString(),

    kpi: {
      revenue_gbp:      Math.round(grossGbp * 100) / 100,
      sites_live:       totalDelivered,
      total_emailed:    sent,
      total_opened:     totalOpened  || 0,
      total_clicked:    totalClicked || 0,
      total_replied:    totalReplied || 0,
      build_pool:       buildPool    || 0,
      enrich_queue:     enrichQueue  || 0,
      excluded:         excludedCount || 0,
      total_businesses: totalBusinesses || 0,
    },

    engagement: {
      open_rate:  sent > 0 ? Math.round((totalOpened  || 0) / sent * 100) : 0,
      click_rate: sent > 0 ? Math.round((totalClicked || 0) / sent * 100) : 0,
      reply_rate: sent > 0 ? Math.round((totalReplied || 0) / sent * 100) : 0,
    },

    temps: { hot: hotCount || 0, warm: warmCount || 0, cold: coldCount || 0 },
    pipeline_counts: pipelineCountMap,

    funnel: {
      viewed:          checkoutViewed         || 0,
      domain_selected: checkoutDomainSelected || 0,
      payment_started: checkoutPaymentStarted || 0,
      completed:       totalPaid + totalDelivered,
      abandoned:       Math.max(0, (checkoutPaymentStarted || 0) - totalPaid - totalDelivered),
    },

    costs: {
      total_usd:       Math.round(totalUsd * 100) / 100,
      total_gbp:       Math.round(totalGbp * 100) / 100,
      per_contact_gbp: sent > 0 ? Math.round((totalGbp / sent) * 1000) / 1000 : null,
      overhead_pct:    grossGbp > 0 ? Math.round((totalGbp / grossGbp) * 1000) / 10 : null,
    },

    template_built:      templateBuilt      || [],
    emailed:             emailedPipeline    || [],
    queue:             { hot: hotQueue || [], warm: warmQueue || [] },
    enrichment_recent:   enrichmentRecent   || [],
    paying:              paying             || [],
    live:                live               || [],
    recent_interactions: recentInteractions || [],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
