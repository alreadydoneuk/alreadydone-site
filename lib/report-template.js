// HTML email template for the monthly business intelligence report.
// Two modes: 'full' (paid subscribers) and 'free_trial' (one-time free gift).
// Charts via QuickChart.io (free, URL-based, no dependency).

const TRACK_BASE = process.env.CHECKOUT_BASE_URL
  ? process.env.CHECKOUT_BASE_URL.replace('/checkout', '')
  : 'https://alreadydone.uk';

// ── QuickChart helpers ─────────────────────────────────────────────────────────

function competitorChart(competitors, customerName, customerReviewCount) {
  // Horizontal bar: customer highlighted in blue, competitors in grey
  const all = [
    ...competitors.slice(0, 4),
    { title: customerName, review_count: customerReviewCount, is_customer: true },
  ].sort((a, b) => (b.review_count || 0) - (a.review_count || 0));

  const labels = all.map(c => c.is_customer ? `★ ${c.title}` : c.title);
  const values = all.map(c => c.review_count || 0);
  const colors = all.map(c => c.is_customer ? '#2563eb' : '#d1d5db');

  const config = {
    type: 'horizontalBar',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderRadius: 4 }],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { beginAtZero: true, fontColor: '#6b7280' }, gridLines: { color: '#f3f4f6' } }],
        yAxes: [{ ticks: { fontColor: '#374151', fontStyle: 'normal' } }],
      },
      plugins: { datalabels: { anchor: 'end', align: 'end', color: '#374151', font: { size: 11 } } },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?w=520&h=200&bkg=white&c=${encoded}`;
}

function rankTrendChart(current, previous) {
  if (!current || !previous || !current.search_rank || !previous.search_rank) return null;
  const config = {
    type: 'line',
    data: {
      labels: [previous.period, current.period],
      datasets: [{
        data: [previous.search_rank, current.search_rank],
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37,99,235,0.08)',
        fill: true,
        tension: 0.3,
        pointRadius: 5,
        pointBackgroundColor: '#2563eb',
      }],
    },
    options: {
      legend: { display: false },
      scales: {
        yAxes: [{ ticks: { reverse: true, min: 1, fontColor: '#6b7280' }, gridLines: { color: '#f3f4f6' } }],
        xAxes: [{ ticks: { fontColor: '#6b7280' } }],
      },
    },
  };
  const encoded = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?w=400&h=160&bkg=white&c=${encoded}`;
}

// ── Delta helpers ──────────────────────────────────────────────────────────────

function delta(current, previous, field, higherIsBetter = true) {
  if (current?.[field] == null || previous?.[field] == null) return null;
  const diff = current[field] - previous[field];
  if (diff === 0) return { diff: 0, label: 'unchanged', positive: null };
  const positive = higherIsBetter ? diff > 0 : diff < 0;
  return {
    diff: Math.abs(diff),
    label: diff > 0 ? `+${Math.abs(diff)}` : `-${Math.abs(diff)}`,
    positive,
    arrow: positive ? '↑' : '↓',
    color: positive ? '#16a34a' : '#dc2626',
  };
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const CSS = `
  body { margin:0; padding:0; background:#f5f5f4; font-family:Inter,system-ui,sans-serif; }
  .wrap { max-width:600px; margin:0 auto; padding:24px 12px; }
  .card { background:#fff; border-radius:12px; padding:28px 24px; margin-bottom:16px; border:1px solid #e5e7eb; }
  .header { background:#0f172a; border-radius:12px; padding:24px; margin-bottom:16px; text-align:center; }
  h1 { margin:0; font-size:22px; font-weight:800; color:#fff; letter-spacing:-0.5px; }
  .subtitle { color:#94a3b8; font-size:13px; margin-top:6px; }
  h2 { margin:0 0 16px; font-size:15px; font-weight:700; color:#111827; letter-spacing:-0.2px; }
  p { margin:0 0 10px; font-size:14px; color:#374151; line-height:1.6; }
  .metrics { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:0; }
  .metric { background:#f9fafb; border-radius:8px; padding:14px 16px; border:1px solid #f3f4f6; }
  .metric-label { font-size:11px; font-weight:600; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px; }
  .metric-value { font-size:22px; font-weight:800; color:#111827; margin:4px 0 2px; }
  .metric-delta { font-size:12px; font-weight:600; }
  .review { background:#f9fafb; border-radius:8px; padding:12px 14px; margin-bottom:10px; border-left:3px solid #2563eb; }
  .review-text { font-size:13px; color:#374151; font-style:italic; margin-bottom:6px; }
  .review-meta { font-size:11px; color:#9ca3af; }
  .stars { color:#f59e0b; }
  .competitor-row { display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid #f3f4f6; font-size:13px; }
  .competitor-row:last-child { border-bottom:none; }
  .you-row { background:#eff6ff; border-radius:6px; padding:8px 10px; font-weight:700; color:#1d4ed8; }
  .company-new { background:#fef3c7; border-radius:6px; padding:8px 12px; margin-bottom:8px; font-size:13px; color:#92400e; }
  .health-row { display:flex; align-items:center; gap:8px; padding:6px 0; font-size:13px; color:#374151; }
  .dot-green { width:8px; height:8px; border-radius:50%; background:#22c55e; flex-shrink:0; }
  .dot-red { width:8px; height:8px; border-radius:50%; background:#ef4444; flex-shrink:0; }
  .dot-grey { width:8px; height:8px; border-radius:50%; background:#d1d5db; flex-shrink:0; }
  .cta-btn { display:block; background:#2563eb; color:#fff !important; text-decoration:none; font-weight:700; font-size:15px; text-align:center; padding:14px 24px; border-radius:8px; margin:16px 0 0; }
  .cta-secondary { display:block; background:#f3f4f6; color:#374151 !important; text-decoration:none; font-weight:600; font-size:13px; text-align:center; padding:10px 20px; border-radius:8px; margin-top:10px; }
  .free-banner { background:linear-gradient(135deg,#1d4ed8,#7c3aed); border-radius:12px; padding:24px; text-align:center; margin-bottom:16px; }
  .free-banner h2 { color:#fff; margin:0 0 8px; font-size:18px; }
  .free-banner p { color:rgba(255,255,255,0.85); font-size:13px; margin:0 0 16px; }
  .blur-section { filter:blur(4px); pointer-events:none; opacity:0.6; user-select:none; }
  .locked-overlay { text-align:center; padding:20px; background:#fff; border-radius:8px; margin-top:8px; }
  .footer { text-align:center; font-size:11px; color:#9ca3af; padding:16px 0; }
  img { max-width:100%; border-radius:8px; }
  @media(max-width:480px) { .metrics { grid-template-columns:1fr 1fr; } .metric-value { font-size:18px; } }
`;

// ── Main template function ─────────────────────────────────────────────────────

export function generateReportEmail({
  business,
  current,
  previous,
  narrative,
  reportType,    // 'full' | 'free_trial'
  trackingId,
  upgradeUrl,
  period,        // e.g. '2026-05'
}) {
  const name = business.customer_first_name || 'there';
  const domain = business.registered_domain;
  const periodLabel = formatPeriod(period);
  const isFree = reportType === 'free_trial';

  const rankDelta = delta(current, previous, 'search_rank', false);  // lower rank = better
  const reviewDelta = delta(current, previous, 'review_count', true);

  const chartUrl = (current?.competitors?.length && current.review_count)
    ? competitorChart(current.competitors, business.name, current.review_count)
    : null;

  const rankChartUrl = rankTrendChart(current, previous);

  // Metric cards
  function metricCard(label, value, d, suffix = '') {
    const deltaHtml = d ? `<div class="metric-delta" style="color:${d.color}">${d.arrow} ${d.label} vs last month</div>` : '';
    return `
    <div class="metric">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value ?? '—'}${suffix}</div>
      ${deltaHtml}
    </div>`;
  }

  const rankLabel = current?.search_rank
    ? `#${current.search_rank} of 10`
    : (current?.search_keyword ? 'Not in top 10' : '—');

  const uptimeLabel = current?.uptime_ok === true ? '100%' : current?.uptime_ok === false ? 'Down' : '—';
  const loadLabel = current?.site_load_ms ? `${current.site_load_ms}ms` : '—';

  // Reviews section
  const reviewsHtml = (current?.recent_reviews || []).slice(0, 3).map(r => `
    <div class="review">
      <div class="review-text">"${escHtml(r.text || '').slice(0, 200)}…"</div>
      <div class="review-meta">
        <span class="stars">${'★'.repeat(r.rating || 5)}</span>
        &nbsp;${escHtml(r.author || '')} · ${escHtml(r.relative_date || '')}
      </div>
    </div>`).join('') || '<p style="color:#9ca3af;font-size:13px;">No recent reviews captured this period.</p>';

  // Competitors section
  const allCompetitors = current?.competitors || [];
  const competitorTableRows = allCompetitors.slice(0, 5).map((c, i) => `
    <div class="competitor-row">
      <span style="color:#6b7280;width:22px;">${c.rank}.</span>
      <span style="flex:1;">${escHtml(c.title || '')}</span>
      <span style="color:#f59e0b;">★ ${c.rating ?? '—'}</span>
      <span style="color:#6b7280;margin-left:12px;">${c.review_count ?? '?'} reviews</span>
    </div>`).join('');

  const customerCompetitorRow = current?.search_rank ? `
    <div class="competitor-row you-row">
      <span style="width:22px;">${current.search_rank}.</span>
      <span style="flex:1;">${escHtml(business.name)} ← YOU</span>
      <span>★ ${current.google_rating ?? '—'}</span>
      <span style="margin-left:12px;">${current.review_count ?? '?'} reviews</span>
    </div>` : `
    <div style="background:#fef9c3;border-radius:6px;padding:10px 12px;font-size:13px;color:#713f12;margin-top:8px;">
      ⚠️ ${escHtml(business.name)} wasn't found in the top 10 for "${escHtml(current?.search_keyword || '')}".
      More photos, reviews, and an updated Google Business Profile can move the needle.
    </div>`;

  // New companies section
  const newCoCount = current?.new_competitors_30d || 0;
  const newCoNames = current?.new_competitor_names || [];
  const newCoHtml = newCoCount > 0
    ? newCoNames.map(n => `<div class="company-new">🆕 ${escHtml(n)}</div>`).join('') +
      (newCoCount > newCoNames.length ? `<p style="font-size:12px;color:#6b7280;">+ ${newCoCount - newCoNames.length} more registrations in your area</p>` : '')
    : '<p style="font-size:13px;color:#9ca3af;">No new businesses registered in your trade/area this month. Good sign.</p>';

  // Site health
  function healthRow(ok, label) {
    const dot = ok === true ? 'dot-green' : ok === false ? 'dot-red' : 'dot-grey';
    return `<div class="health-row"><div class="${dot}"></div>${label}</div>`;
  }
  const healthHtml = `
    ${healthRow(current?.uptime_ok, `Site responding — ${loadLabel} load time`)}
    ${healthRow(current?.has_title_tag, 'Page title set')}
    ${healthRow(current?.has_meta_description, 'Meta description set')}
  `;

  // CTA URLs with tracking
  const clickTrackUrl = (dest) =>
    `${TRACK_BASE}/api/report-track?id=${trackingId}&e=click&r=${encodeURIComponent(dest)}`;

  const subscribeUrl = upgradeUrl || `${TRACK_BASE}/checkout?slug=${business.site_slug}&report=1`;

  // Tracking pixel (1x1 transparent gif via CF Pages Function)
  const pixelHtml = `<img src="${TRACK_BASE}/api/report-track?id=${trackingId}&e=open" width="1" height="1" style="display:block;" alt="">`;

  // ── Free trial banner ────────────────────────────────────────────────────────
  const freeBannerHtml = isFree ? `
  <div class="free-banner">
    <h2>Your free business intelligence report 🎁</h2>
    <p>This is a one-time complimentary report for ${escHtml(domain)}. Subscribe for £5/month to get this every month — with trend comparisons, new competitor alerts, and unanswered review Q&A flagged automatically.</p>
    <a href="${clickTrackUrl(subscribeUrl)}" class="cta-btn" style="display:inline-block;background:#fff;color:#1d4ed8 !important;">Subscribe for £5/month →</a>
  </div>` : '';

  // ── Locked overlay for free_trial competitor section ──────────────────────────
  const competitorSectionStart = isFree ? '<div class="blur-section">' : '';
  const competitorSectionEnd = isFree ? `</div>
  <div class="locked-overlay">
    <p style="font-size:15px;font-weight:700;margin-bottom:6px;">🔒 Competitor & trends data</p>
    <p style="font-size:13px;color:#6b7280;margin-bottom:12px;">Full competitor rankings, review velocity, new company alerts, and month-on-month rank tracking are included in the monthly subscription.</p>
    <a href="${clickTrackUrl(subscribeUrl)}" class="cta-btn">Get the full report every month — £5/month →</a>
  </div>` : '';

  // ── Narrative (Claude-generated) ─────────────────────────────────────────────
  const narrativeHtml = narrative
    ? `<div class="card"><p style="font-size:14px;line-height:1.7;color:#374151;">${narrative.split('\n\n').map(p => `<p>${escHtml(p)}</p>`).join('')}</p></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${periodLabel} report — ${escHtml(domain)}</title>
  <style>${CSS}</style>
</head>
<body>
<div class="wrap">

  ${pixelHtml}

  <!-- Header -->
  <div class="header">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#94a3b8;margin-bottom:8px;">ALREADY DONE</div>
    <h1>${periodLabel} business report</h1>
    <div class="subtitle">${escHtml(domain)}</div>
  </div>

  ${freeBannerHtml}

  <!-- Greeting -->
  <div class="card">
    <p>Hi ${escHtml(name)},</p>
    <p>Here's your ${periodLabel} snapshot for <strong>${escHtml(domain)}</strong>.
    ${isFree ? 'This is a complimentary report — no action needed.' : 'Everything below is pulled fresh this month.'}</p>
  </div>

  ${narrativeHtml}

  <!-- At a glance -->
  <div class="card">
    <h2>At a glance</h2>
    <div class="metrics">
      ${metricCard('Local search rank', rankLabel, rankDelta)}
      ${metricCard('Google reviews', current?.review_count, reviewDelta)}
      ${metricCard('Google rating', current?.google_rating ? `${current.google_rating}★` : null, null)}
      ${metricCard('Uptime', uptimeLabel, null)}
    </div>
  </div>

  <!-- Recent reviews -->
  <div class="card">
    <h2>Recent reviews</h2>
    ${reviewsHtml}
    ${current?.photo_count != null ? `<p style="margin-top:14px;font-size:13px;color:#6b7280;">📷 Google Business Profile photos: <strong>${current.photo_count}+</strong>${
      allCompetitors.length ? ` &nbsp;·&nbsp; Top competitors average <strong>${Math.round(allCompetitors.reduce((s, c) => s + (c.review_count || 0), 0) / allCompetitors.length)}</strong> reviews` : ''
    }</p>` : ''}
  </div>

  <!-- Competitor section — blurred for free trial -->
  ${competitorSectionStart}
  <div class="card">
    <h2>Local search — ${escHtml(current?.search_keyword || buildSearchKeyword(business))}</h2>
    ${chartUrl ? `<img src="${chartUrl}" alt="Competitor review counts" style="margin-bottom:16px;">` : ''}
    ${customerCompetitorRow}
    ${competitorTableRows}
    ${rankChartUrl ? `<div style="margin-top:20px;"><h2 style="margin-bottom:8px;">Rank trend</h2><img src="${rankChartUrl}" alt="Rank trend"></div>` : ''}
  </div>

  <div class="card">
    <h2>New competitors this month</h2>
    ${newCoHtml}
  </div>
  ${competitorSectionEnd}

  <!-- Site health -->
  <div class="card">
    <h2>Site health</h2>
    ${healthHtml}
    ${!current?.has_meta_description ? `<p style="margin-top:12px;background:#fef9c3;padding:10px 12px;border-radius:6px;font-size:13px;color:#713f12;">
      💡 Adding a meta description can improve click-through rates in search results.
      <a href="${clickTrackUrl(`${TRACK_BASE}/checkout?slug=${business.site_slug}&upgrade=seo`)}" style="color:#1d4ed8;">Request a free SEO copy refresh →</a>
    </p>` : ''}
  </div>

  <!-- CTA -->
  ${isFree ? `
  <div class="card" style="background:linear-gradient(135deg,#eff6ff,#f5f3ff);border-color:#bfdbfe;">
    <h2 style="color:#1e40af;">Get this every month</h2>
    <p>You're getting this for free — once. Subscribe to see how your rank, reviews, and competitor landscape change month by month. The longer you're subscribed, the richer the trend data.</p>
    <a href="${clickTrackUrl(subscribeUrl)}" class="cta-btn">Start for £5/month →</a>
    <p style="font-size:12px;color:#9ca3af;margin-top:10px;">Cancel any time. No minimum term.</p>
  </div>` : `
  <div style="text-align:center;padding:8px 0 16px;">
    <a href="${clickTrackUrl(`${TRACK_BASE}/checkout?slug=${business.site_slug}&upgrade=seo`)}" class="cta-secondary">💡 Free SEO copy refresh</a>
  </div>`}

  <div class="footer">
    <p>Already Done · <a href="https://alreadydone.uk" style="color:#9ca3af;">alreadydone.uk</a></p>
    <p>You're receiving this because your site is hosted by Already Done.
    <a href="mailto:dean@alreadydone.uk" style="color:#9ca3af;">Contact us</a>.</p>
  </div>

</div>
</body>
</html>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatPeriod(period) {
  if (!period || period === 'baseline') return 'Baseline';
  const [year, month] = period.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(month, 10) - 1]} ${year}`;
}

function buildSearchKeyword(business) {
  const parts = (business.location || '').split(',');
  const city = parts[parts.length - 1].trim();
  return `${(business.category || '').toLowerCase()} ${city}`.trim();
}
