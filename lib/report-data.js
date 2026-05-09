// Data collection for the monthly business intelligence report.
// Pulls from Google Places, Serper local search, Companies House, and site health check.
// All pulls are graceful — missing API keys or failed calls return null, never throw.

import { supabase } from './db.js';
import 'dotenv/config';

const PLACES_API = 'https://maps.googleapis.com/maps/api/place';
const SERPER_API = 'https://google.serper.dev/places';
const CH_API     = 'https://api.company-information.service.gov.uk';
const PH_HOST    = () => (process.env.POSTHOG_HOST || 'https://eu.i.posthog.com').replace(/\/$/, '');

// ── Search keyword ─────────────────────────────────────────────────────────────

export function buildSearchKeyword(business) {
  // "Bonnington, Edinburgh" → "Edinburgh"; "Edinburgh" → "Edinburgh"
  const parts = (business.location || '').split(',');
  const city = parts[parts.length - 1].trim();
  const cat = (business.category || '').toLowerCase();
  return `${cat} ${city}`.trim();
}

// ── Google Places ──────────────────────────────────────────────────────────────

async function getPlacesData(business) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;

  // Use stored place_id if available; otherwise text search
  let placeId = business.place_id;

  if (!placeId) {
    try {
      const query = encodeURIComponent(`${business.name} ${business.location}`);
      const res = await fetch(
        `${PLACES_API}/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id&key=${key}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const data = await res.json();
      placeId = data.candidates?.[0]?.place_id || null;
    } catch { return null; }
  }

  if (!placeId) return null;

  try {
    const fields = 'rating,user_ratings_total,photos,reviews';
    const res = await fetch(
      `${PLACES_API}/details/json?place_id=${placeId}&fields=${fields}&key=${key}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    const r = data.result;
    if (!r) return null;

    return {
      google_rating: r.rating ?? null,
      review_count: r.user_ratings_total ?? null,
      photo_count: r.photos?.length ?? null,  // Places API returns max 10; treat as "at least N"
      recent_reviews: (r.reviews || []).slice(0, 5).map(rv => ({
        text: rv.text,
        rating: rv.rating,
        author: rv.author_name,
        relative_date: rv.relative_time_description,
      })),
    };
  } catch { return null; }
}

// ── Serper local search ────────────────────────────────────────────────────────

async function getLocalSearchData(business, keyword) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(SERPER_API, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: keyword, gl: 'gb', num: 10 }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const places = data.places || [];

    // Find customer's rank by matching domain in website field
    const customerDomain = (business.registered_domain || business.domain || '').toLowerCase()
      .replace(/^www\./, '');

    let customerRank = null;
    const competitors = places.map((p, i) => {
      const siteDomain = (p.website || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      const isCustomer = customerDomain && siteDomain && (siteDomain === customerDomain || siteDomain.includes(customerDomain) || customerDomain.includes(siteDomain));
      if (isCustomer) customerRank = i + 1;
      return {
        title: p.title,
        rating: p.rating || null,
        review_count: p.ratingCount || p.reviewCount || null,
        address: p.address || null,
        website: p.website || null,
        rank: i + 1,
        is_customer: isCustomer,
      };
    });

    return {
      search_keyword: keyword,
      search_rank: customerRank,
      competitors: competitors.filter(c => !c.is_customer).slice(0, 7),
    };
  } catch { return null; }
}

// ── Companies House — new competitors in area ──────────────────────────────────

async function getNewCompetitors(business) {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;

  const parts = (business.location || '').split(',');
  const city = parts[parts.length - 1].trim();
  if (!city) return { new_competitors_30d: 0, new_competitor_names: [] };

  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  // Use category as keyword — e.g. "plumber" matches company names containing the trade
  const keyword = (business.category || '').split(' ')[0];

  const params = new URLSearchParams({
    q: `${keyword} ${city}`,
    incorporated_from: from,
    incorporated_to: to,
    company_status: 'active',
    size: '20',
  });

  const headers = { 'Accept': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  }

  try {
    const res = await fetch(`${CH_API}/advanced-search/companies?${params}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { new_competitors_30d: 0, new_competitor_names: [] };
    const data = await res.json();
    const items = data.items || [];
    return {
      new_competitors_30d: items.length,
      new_competitor_names: items.slice(0, 5).map(i => i.company_name),
    };
  } catch {
    return { new_competitors_30d: 0, new_competitor_names: [] };
  }
}

// ── PostHog analytics ──────────────────────────────────────────────────────────

async function getPosthogData(domain, period) {
  const apiKey = process.env.POSTHOG_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!apiKey || !projectId || !domain) return null;

  // period '2026-05' → date range
  const [year, month] = (period || '').split('-').map(Number);
  if (!year || !month) return null;
  const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
  const end   = new Date(year, month, 1).toISOString().split('T')[0];

  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const phQuery = async (query) => {
    try {
      const res = await fetch(`${PH_HOST()}/api/projects/${projectId}/query/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return null;
      return (await res.json()).results ?? null;
    } catch { return null; }
  };

  // Visitors + pageviews
  const totals = await phQuery(`
    SELECT uniqExact(distinct_id) AS visitors, count() AS pageviews
    FROM events
    WHERE event = '$pageview'
      AND properties.$host = '${domain}'
      AND timestamp >= '${start}' AND timestamp < '${end}'
  `);
  if (!totals?.[0]) return null;
  const [visitors, pageviews] = totals[0];

  // Top pages
  const pagesRows = await phQuery(`
    SELECT properties.$pathname AS path, count() AS views
    FROM events
    WHERE event = '$pageview'
      AND properties.$host = '${domain}'
      AND timestamp >= '${start}' AND timestamp < '${end}'
    GROUP BY path ORDER BY views DESC LIMIT 5
  `);
  const top_pages = (pagesRows || []).map(([path, views]) => ({
    path: path || '/',
    views,
    pct: pageviews ? Math.round((views / pageviews) * 100) : 0,
  }));

  // Traffic sources
  const sourceRows = await phQuery(`
    SELECT
      multiIf(
        properties.$referring_domain IS NULL OR properties.$referring_domain = '', 'direct',
        properties.$referring_domain LIKE '%google%' OR properties.$referring_domain LIKE '%bing%', 'organic',
        properties.$referring_domain LIKE '%facebook%' OR properties.$referring_domain LIKE '%instagram%' OR properties.$referring_domain LIKE '%twitter%' OR properties.$referring_domain LIKE '%tiktok%', 'social',
        'other'
      ) AS source,
      count() AS views
    FROM events
    WHERE event = '$pageview'
      AND properties.$host = '${domain}'
      AND timestamp >= '${start}' AND timestamp < '${end}'
    GROUP BY source ORDER BY views DESC
  `);
  const total = (sourceRows || []).reduce((s, [, v]) => s + v, 0);
  const traffic_sources = {};
  for (const [src, views] of (sourceRows || [])) {
    traffic_sources[src] = total ? Math.round((views / total) * 100) : 0;
  }

  return { visitors, pageviews, top_pages, traffic_sources };
}

// ── Site health check ──────────────────────────────────────────────────────────

async function checkSiteHealth(domain) {
  if (!domain) return { uptime_ok: null, site_load_ms: null, has_meta_description: null, has_title_tag: null };

  const url = `https://${domain}`;
  const start = Date.now();

  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(12000) });
    const load_ms = Date.now() - start;
    const uptime_ok = res.ok;

    // Quick SEO checks on the HTML
    let has_meta_description = null;
    let has_title_tag = null;

    if (uptime_ok) {
      try {
        const html = await res.text();
        has_meta_description = /<meta\s[^>]*name=["']description["'][^>]*content=["'][^"']+["']/i.test(html);
        has_title_tag = /<title>[^<]{5,}<\/title>/i.test(html);
      } catch { /* html parse failed */ }
    }

    return { uptime_ok, site_load_ms: load_ms, has_meta_description, has_title_tag };
  } catch {
    return { uptime_ok: false, site_load_ms: null, has_meta_description: null, has_title_tag: null };
  }
}

// ── Main: capture and store a snapshot ────────────────────────────────────────

export async function captureSnapshot(business, period) {
  const keyword = buildSearchKeyword(business);
  console.log(`  [snapshot] ${business.name} — ${period} — keyword: "${keyword}"`);

  // Run data pulls in parallel; each handles its own failures
  const [placesData, searchData, competitorData, healthData, posthogData] = await Promise.all([
    getPlacesData(business),
    getLocalSearchData(business, keyword),
    getNewCompetitors(business),
    checkSiteHealth(business.registered_domain || business.domain),
    getPosthogData(business.registered_domain || business.domain, period),
  ]);

  const snapshot = {
    business_id: business.id,
    period,
    // Places
    google_rating: placesData?.google_rating ?? business.google_rating ?? null,
    review_count: placesData?.review_count ?? business.review_count ?? null,
    photo_count: placesData?.photo_count ?? null,
    recent_reviews: placesData?.recent_reviews ?? null,
    // Search rank
    search_keyword: searchData?.search_keyword ?? keyword,
    search_rank: searchData?.search_rank ?? null,
    competitors: searchData?.competitors ?? null,
    // Companies House
    new_competitors_30d: competitorData?.new_competitors_30d ?? 0,
    new_competitor_names: competitorData?.new_competitor_names ?? [],
    // Site health (kept for internal monitoring, not surfaced in report)
    uptime_ok: healthData?.uptime_ok ?? null,
    site_load_ms: healthData?.site_load_ms ?? null,
    has_meta_description: healthData?.has_meta_description ?? null,
    has_title_tag: healthData?.has_title_tag ?? null,
    // PostHog analytics
    visitors: posthogData?.visitors ?? null,
    pageviews: posthogData?.pageviews ?? null,
    top_pages: posthogData?.top_pages ?? null,
    traffic_sources: posthogData?.traffic_sources ?? null,
  };

  const { error } = await supabase
    .from('report_snapshots')
    .upsert(snapshot, { onConflict: 'business_id,period' });

  if (error) console.error(`  [snapshot] DB error for ${business.name}: ${error.message}`);
  else {
    await supabase.from('businesses').update({ last_snapshot_at: new Date().toISOString() }).eq('id', business.id);
    console.log(`  [snapshot] ✓ ${business.name} — rank: ${snapshot.search_rank ?? 'not found'}, reviews: ${snapshot.review_count ?? '?'}`);
  }

  return snapshot;
}

// ── PostHog: prospect preview engagement ───────────────────────────────────────
// Queries /preview/* pageviews on alreadydone.uk to see which prospects are hot.
// Returns array of { slug, views, last_seen } sorted by views desc.

export async function getPreviewEngagement({ days = 7 } = {}) {
  const apiKey = process.env.POSTHOG_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST || 'https://eu.i.posthog.com').replace(/\/$/, '');
  if (!apiKey || !projectId) return [];

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const res = await fetch(`${host}/api/projects/${projectId}/query/`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: {
          kind: 'HogQLQuery',
          query: `
            SELECT
              properties.$pathname AS path,
              count() AS views,
              max(timestamp) AS last_seen
            FROM events
            WHERE event = '$pageview'
              AND properties.$host = 'alreadydone.uk'
              AND properties.$pathname LIKE '/preview/%'
              AND timestamp >= '${since}'
            GROUP BY path
            ORDER BY views DESC
            LIMIT 50
          `,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(([path, views, last_seen]) => ({
      slug: path.replace('/preview/', '').replace(/\/$/, ''),
      path,
      views,
      last_seen,
    }));
  } catch { return []; }
}

// ── Get latest two snapshots for a business (for diff) ────────────────────────

export async function getSnapshotPair(businessId) {
  const { data } = await supabase
    .from('report_snapshots')
    .select('*')
    .eq('business_id', businessId)
    .order('captured_at', { ascending: false })
    .limit(2);

  const current = data?.[0] ?? null;
  const previous = data?.[1] ?? null;
  return { current, previous };
}
