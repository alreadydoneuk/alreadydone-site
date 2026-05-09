// HTML email template for the monthly business intelligence report.
// Design principles:
//   - Mobile-first (375px base, 600px max)
//   - Hero rank number fills the first screen — data before narrative
//   - Free trial: rank + reviews + traffic visible; competitor intel locked behind paywall card

const TRACK_BASE = (process.env.CHECKOUT_BASE_URL || 'https://alreadydone.uk/checkout').replace('/checkout', '');

// ── QuickChart competitor bar ──────────────────────────────────────────────────

function competitorChart(competitors, customerName, customerReviewCount) {
  const all = [
    ...competitors.slice(0, 4),
    { title: customerName, review_count: customerReviewCount, is_customer: true },
  ].sort((a, b) => (b.review_count || 0) - (a.review_count || 0));

  const config = {
    type: 'horizontalBar',
    data: {
      labels: all.map(c => c.is_customer ? `► ${(c.title||'').slice(0, 22)}` : (c.title||'').slice(0, 22)),
      datasets: [{
        data: all.map(c => c.review_count || 0),
        backgroundColor: all.map(c => c.is_customer ? '#2563eb' : '#e2e8f0'),
        borderRadius: 4,
      }],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { beginAtZero: true, fontColor: '#94a3b8', fontSize: 10 }, gridLines: { color: '#f1f5f9', zeroLineColor: '#e2e8f0' } }],
        yAxes: [{ ticks: { fontColor: '#334155', fontSize: 11 } }],
      },
      plugins: { datalabels: { anchor: 'end', align: 'end', color: '#334155', font: { size: 10 } } },
    },
  };
  return `https://quickchart.io/chart?w=540&h=${Math.max(160, all.length * 40)}&bkg=%23ffffff&c=${encodeURIComponent(JSON.stringify(config))}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatPeriod(period) {
  if (!period || period === 'baseline') return 'Baseline';
  const [year, month] = period.split('-');
  return `${['January','February','March','April','May','June','July','August','September','October','November','December'][+month - 1]} ${year}`;
}

function cityFromLocation(location) {
  const parts = (location || '').split(',');
  return parts[parts.length - 1].trim();
}

// Round to N decimal places cleanly (avoids 0.19999999...)
function round(val, dp = 0) {
  const factor = Math.pow(10, dp);
  return Math.round((val || 0) * factor) / factor;
}

function delta(current, previous, field, higherIsBetter = true, dp = 0) {
  if (current?.[field] == null || previous?.[field] == null) return null;
  const diff = round(current[field] - previous[field], dp);
  if (diff === 0) return null;
  const positive = higherIsBetter ? diff > 0 : diff < 0;
  const abs = Math.abs(diff);
  const label = diff > 0 ? `+${dp > 0 ? abs.toFixed(dp) : abs}` : `${dp > 0 ? (-abs).toFixed(dp) : diff}`;
  return { diff, positive, label, arrow: positive ? '↑' : '↓' };
}

// ── Main export ────────────────────────────────────────────────────────────────

export function generateReportEmail({ business, current, previous, narrative, reportType, trackingId, upgradeUrl, period }) {
  const name = business.customer_first_name || 'there';
  const domain = business.registered_domain;
  const periodLabel = formatPeriod(period);
  const isFree = reportType === 'free_trial';

  const rankD  = delta(current, previous, 'search_rank', false);
  const reviewD = delta(current, previous, 'review_count', true);
  const ratingD = delta(current, previous, 'google_rating', true, 1);

  const rank = current?.search_rank;
  const keyword = current?.search_keyword || `${(business.category||'').toLowerCase()} ${cityFromLocation(business.location)}`;
  const allCompetitors = current?.competitors || [];
  const chartUrl = (allCompetitors.length && current?.review_count)
    ? competitorChart(allCompetitors, business.name, current.review_count)
    : null;

  const clickUrl = (dest) => `${TRACK_BASE}/api/report-track?id=${esc(trackingId)}&e=click&r=${encodeURIComponent(dest)}`;
  const subscribeUrl = upgradeUrl || `${TRACK_BASE}/checkout?slug=${esc(business.site_slug || '')}&report=1`;
  const pixel = `<img src="${TRACK_BASE}/api/report-track?id=${esc(trackingId)}&e=open" width="1" height="1" style="display:block;border:0;" alt="">`;

  // ── Hero ─────────────────────────────────────────────────────────────────────
  const hasRank = rank != null;
  const rankColor = !rankD ? '#fff' : rankD.positive ? '#4ade80' : '#f87171';
  const rankDeltaHtml = rankD
    ? `<div style="font-size:15px;font-weight:700;color:${rankColor};margin-top:8px;">${rankD.arrow} ${Math.abs(rankD.diff)} place${Math.abs(rankD.diff) !== 1 ? 's' : ''} since last month</div>`
    : '';
  const rankSubtext = `<div style="font-size:12px;color:#64748b;margin-top:8px;letter-spacing:0.3px;">"${esc(keyword)}"</div>`;

  const heroMainHtml = hasRank
    ? `<div style="font-size:80px;font-weight:900;color:#fff;line-height:1;letter-spacing:-3px;">#${rank}</div>
       <div style="font-size:13px;font-weight:700;color:#94a3b8;letter-spacing:1.5px;margin-top:4px;">LOCAL SEARCH RANK</div>
       ${rankDeltaHtml}${rankSubtext}`
    : `<div style="font-size:64px;font-weight:900;color:#fff;line-height:1;">${current?.review_count ?? '—'}</div>
       <div style="font-size:13px;font-weight:700;color:#94a3b8;letter-spacing:1.5px;margin-top:4px;">GOOGLE REVIEWS</div>
       ${reviewD ? `<div style="font-size:15px;font-weight:700;color:${reviewD.positive ? '#4ade80' : '#f87171'};margin-top:8px;">${reviewD.arrow} ${reviewD.label} this month</div>` : ''}
       ${rankSubtext}`;

  const heroHtml = `
  <div style="background:linear-gradient(160deg,#0f172a 0%,#1e293b 60%,#0f2746 100%);border-radius:16px;padding:36px 24px 28px;text-align:center;margin-bottom:10px;">
    <div style="font-size:10px;font-weight:700;letter-spacing:3px;color:#334155;margin-bottom:18px;">ALREADY DONE · ${esc(periodLabel.toUpperCase())}</div>
    ${heroMainHtml}
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.07);">
      <div style="font-size:12px;color:#475569;">${esc(domain)}</div>
    </div>
  </div>`;

  // ── Stat pills ────────────────────────────────────────────────────────────────
  function pill(emoji, label, value, d) {
    const dHtml = d
      ? `<span style="font-size:9px;color:${d.positive ? '#16a34a' : '#dc2626'};font-weight:700;margin-left:3px;">${d.arrow}${d.dp > 0 ? Math.abs(d.diff).toFixed(d.dp) : Math.abs(d.diff)}</span>`
      : '';
    return `<td style="padding:0 3px;">
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 10px 8px;text-align:center;min-width:68px;">
        <div style="font-size:16px;margin-bottom:3px;">${emoji}</div>
        <div style="font-size:15px;font-weight:800;color:#0f172a;line-height:1;">${esc(String(value ?? '—'))}${dHtml}</div>
        <div style="font-size:9px;color:#94a3b8;margin-top:3px;font-weight:700;letter-spacing:0.5px;">${label}</div>
      </div>
    </td>`;
  }

  const ratingDisplay = current?.google_rating != null ? parseFloat(current.google_rating).toFixed(1) : null;
  const visitorsDisplay = current?.visitors != null ? current.visitors.toLocaleString('en-GB') : null;
  const visitorsD = delta(current, previous, 'visitors', true);

  const statsHtml = `
  <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:10px;">
    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr>
        ${pill('⭐', 'RATING', ratingDisplay, ratingD ? { ...ratingD, dp: 1 } : null)}
        ${pill('💬', 'REVIEWS', current?.review_count, reviewD)}
        ${pill('👥', 'VISITORS', visitorsDisplay, visitorsD)}
        ${pill('📷', 'PHOTOS', current?.photo_count ?? null, null)}
      </tr>
    </table>
  </div>`;

  // ── Best review quote ─────────────────────────────────────────────────────────
  const bestReview = (current?.recent_reviews || []).find(r => r.rating >= 5) || current?.recent_reviews?.[0];
  const bestReviewHtml = bestReview ? `
  <div style="background:#fff;border-radius:14px;padding:22px 20px;margin-bottom:10px;border:1px solid #e2e8f0;border-left:4px solid #2563eb;">
    <div style="font-size:28px;color:#bfdbfe;line-height:1;margin-bottom:6px;">"</div>
    <div style="font-size:14px;color:#1e293b;line-height:1.7;font-weight:500;">${esc((bestReview.text || '').slice(0, 220))}${(bestReview.text || '').length > 220 ? '…' : ''}</div>
    <div style="margin-top:12px;">
      <span style="color:#f59e0b;font-size:13px;">${'★'.repeat(bestReview.rating || 5)}</span>
      <span style="font-size:11px;color:#64748b;font-weight:600;margin-left:6px;">${esc(bestReview.author || '')}${bestReview.relative_date ? ` · ${esc(bestReview.relative_date)}` : ''}</span>
    </div>
  </div>` : '';

  // ── PostHog traffic section ───────────────────────────────────────────────────
  const sources = current?.traffic_sources || null;
  const topPages = current?.top_pages || [];
  const visitors = current?.visitors;
  const pageviews = current?.pageviews;
  const visitorsChange = visitorsD;

  let trafficHtml = '';
  if (visitors != null || pageviews != null || topPages.length > 0) {
    const visitorsChangeHtml = visitorsChange
      ? `<span style="font-size:13px;font-weight:700;color:${visitorsChange.positive ? '#16a34a' : '#dc2626'};margin-left:8px;">${visitorsChange.arrow} ${Math.abs(visitorsChange.diff).toLocaleString('en-GB')} vs last month</span>`
      : '';

    const sourceRows = sources ? Object.entries({
      '🔍 Google': sources.organic || 0,
      '📎 Direct': sources.direct || 0,
      '📱 Social': sources.social || 0,
      '🌐 Other': sources.other || 0,
    }).filter(([, pct]) => pct > 0).sort((a, b) => b[1] - a[1]).map(([label, pct]) => `
      <tr>
        <td style="font-size:12px;color:#475569;padding:4px 8px 4px 0;white-space:nowrap;width:90px;">${label}</td>
        <td style="padding:4px 8px;vertical-align:middle;">
          <div style="background:#f1f5f9;border-radius:3px;height:6px;overflow:hidden;">
            <div style="background:#2563eb;width:${pct}%;height:6px;border-radius:3px;"></div>
          </div>
        </td>
        <td style="font-size:12px;font-weight:700;color:#334155;padding:4px 0 4px 6px;white-space:nowrap;width:35px;text-align:right;">${pct}%</td>
      </tr>`).join('') : '';

    const pageRows = topPages.slice(0, 4).map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #f8fafc;font-size:12px;">
        <span style="color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${esc(p.path || '/')}</span>
        <span style="color:#64748b;white-space:nowrap;margin-left:12px;">${(p.views||0).toLocaleString('en-GB')} views${p.pct ? ` · ${p.pct}%` : ''}</span>
      </div>`).join('');

    trafficHtml = `
  <div style="background:#fff;border-radius:14px;padding:22px 20px;margin-bottom:10px;border:1px solid #e2e8f0;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#94a3b8;margin-bottom:4px;">WEBSITE TRAFFIC</div>
    ${visitors != null ? `
    <div style="margin-bottom:16px;">
      <span style="font-size:28px;font-weight:900;color:#0f172a;line-height:1;">${visitors.toLocaleString('en-GB')}</span>
      <span style="font-size:13px;color:#64748b;font-weight:600;margin-left:6px;">visitors${pageviews ? ` · ${pageviews.toLocaleString('en-GB')} page views` : ''}</span>
      ${visitorsChangeHtml}
    </div>` : ''}
    ${sourceRows ? `
    <div style="margin-bottom:16px;">
      <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.5px;margin-bottom:8px;">WHERE THEY CAME FROM</div>
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        ${sourceRows}
      </table>
    </div>` : ''}
    ${pageRows ? `
    <div>
      <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.5px;margin-bottom:8px;">MOST VISITED PAGES</div>
      ${pageRows}
    </div>` : ''}
  </div>`;
  }

  // ── Competitor section ────────────────────────────────────────────────────────
  const competitorSectionHtml = `
  <div style="background:#fff;border-radius:14px;padding:22px 20px;margin-bottom:10px;border:1px solid #e2e8f0;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#94a3b8;margin-bottom:4px;">LOCAL COMPETITORS</div>
    <div style="font-size:16px;font-weight:800;color:#0f172a;margin-bottom:14px;">"${esc(keyword)}"</div>
    ${chartUrl ? `<img src="${chartUrl}" alt="Review count comparison" style="width:100%;border-radius:8px;margin-bottom:14px;" loading="lazy">` : ''}
    ${rank
      ? `<div style="background:#eff6ff;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:700;color:#1d4ed8;margin-bottom:8px;">▶ ${esc(business.name)} — #${rank} · ${current.review_count} reviews · ⭐${parseFloat(current.google_rating||0).toFixed(1)}</div>`
      : `<div style="background:#fef9c3;border-radius:8px;padding:10px 14px;font-size:13px;color:#92400e;margin-bottom:8px;">Not currently in the top 10 — this is where you want to be</div>`}
    ${allCompetitors.slice(0, 4).map(c => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f8fafc;font-size:12px;color:#334155;">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.rank ? `${c.rank}. ` : ''}${esc(c.title||'')}</span>
      <span style="margin-left:12px;white-space:nowrap;color:#64748b;">⭐${c.rating ?? '—'} · ${(c.review_count||0).toLocaleString('en-GB')} reviews</span>
    </div>`).join('')}
  </div>`;

  // ── New competitors ───────────────────────────────────────────────────────────
  const newCoCount = current?.new_competitors_30d || 0;
  const newCoNames = current?.new_competitor_names || [];
  const newCoHtml = `
  <div style="background:#fff;border-radius:14px;padding:22px 20px;margin-bottom:10px;border:1px solid #e2e8f0;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#94a3b8;margin-bottom:4px;">NEW IN YOUR AREA</div>
    <div style="font-size:16px;font-weight:800;color:#0f172a;margin-bottom:12px;">New ${esc(business.category||'trade')} businesses registered this month</div>
    ${newCoCount === 0
      ? `<div style="background:#f0fdf4;border-radius:8px;padding:12px 14px;font-size:13px;color:#166534;">✓ None this month — no new competition registered near you.</div>`
      : newCoNames.map(n => `<div style="background:#fefce8;border:1px solid #fde047;border-radius:8px;padding:10px 12px;margin-bottom:6px;font-size:13px;color:#713f12;">🆕 ${esc(n)}</div>`).join('') +
        (newCoCount > newCoNames.length ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px;">+ ${newCoCount - newCoNames.length} more in Companies House records</div>` : '')
    }
  </div>`;

  // ── Locked competitor section (free trial) ────────────────────────────────────
  const competitorBlockHtml = isFree ? `
  <div style="background:#f8fafc;border:2px dashed #cbd5e1;border-radius:14px;padding:32px 24px;text-align:center;margin-bottom:10px;">
    <div style="font-size:36px;margin-bottom:12px;">📊</div>
    <div style="font-size:17px;font-weight:800;color:#0f172a;margin-bottom:8px;">Competitor Intelligence</div>
    <div style="font-size:13px;color:#64748b;line-height:1.7;margin-bottom:20px;">
      See exactly where you rank vs. local competitors, how your reviews compare, and every new business that registers near you — every month.
    </div>
    <a href="${clickUrl(subscribeUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;">Unlock for £5/month →</a>
    <div style="font-size:11px;color:#94a3b8;margin-top:10px;">Cancel any time · No contracts</div>
  </div>` : `${competitorSectionHtml}${newCoHtml}`;

  // ── Narrative ─────────────────────────────────────────────────────────────────
  const narrativeHtml = narrative ? `
  <div style="background:#f8fafc;border-radius:14px;padding:20px;margin-bottom:10px;border:1px solid #e2e8f0;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#94a3b8;margin-bottom:12px;">DEAN'S TAKE</div>
    ${narrative.split('\n\n').map(p => `<p style="margin:0 0 12px;font-size:13px;line-height:1.75;color:#334155;">${esc(p)}</p>`).join('')}
  </div>` : '';

  // ── More reviews (paid only) ──────────────────────────────────────────────────
  const otherReviews = (current?.recent_reviews || []).filter(r => r !== bestReview).slice(0, 2);
  const otherReviewsHtml = (!isFree && otherReviews.length > 0) ? `
  <div style="background:#fff;border-radius:14px;padding:22px 20px;margin-bottom:10px;border:1px solid #e2e8f0;">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:#94a3b8;margin-bottom:14px;">MORE RECENT REVIEWS</div>
    ${otherReviews.map(r => `
    <div style="padding:12px 0;border-bottom:1px solid #f8fafc;">
      <div style="font-size:13px;color:#334155;line-height:1.65;font-style:italic;">"${esc((r.text || '').slice(0, 160))}${(r.text||'').length > 160 ? '…' : ''}"</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:6px;"><span style="color:#f59e0b;">${'★'.repeat(r.rating||5)}</span> ${esc(r.author||'')}${r.relative_date ? ` · ${esc(r.relative_date)}` : ''}</div>
    </div>`).join('')}
  </div>` : '';

  // ── Bottom CTA (free trial) ───────────────────────────────────────────────────
  const bottomCtaHtml = isFree ? `
  <div style="background:linear-gradient(135deg,#1e40af,#5b21b6);border-radius:14px;padding:28px 20px;text-align:center;margin-bottom:10px;">
    <div style="font-size:19px;font-weight:800;color:#fff;margin-bottom:8px;">This report, every month</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-bottom:20px;line-height:1.7;">Your rank, competitor moves, new businesses in your area, and website traffic — all in one place. £5/month. Cancel whenever.</div>
    <a href="${clickUrl(subscribeUrl)}" style="display:inline-block;background:#fff;color:#1e40af;text-decoration:none;font-weight:800;font-size:15px;padding:14px 32px;border-radius:10px;">Start for £5/month →</a>
    <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:10px;">Cancel any time · No contracts</div>
  </div>` : '';

  // ── Assemble ──────────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(periodLabel)} report — ${esc(domain)}</title>
  <style>
    * { box-sizing:border-box; }
    body { margin:0; padding:0; background:#f1f5f9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
    a { color:#2563eb; }
    img { max-width:100%; height:auto; }
    @media(max-width:480px) { .wrap { padding:12px 8px !important; } }
  </style>
</head>
<body>
<div class="wrap" style="max-width:600px;margin:0 auto;padding:20px 14px;">

  ${pixel}
  ${heroHtml}
  ${statsHtml}
  ${bestReviewHtml}
  ${trafficHtml}
  ${competitorBlockHtml}
  ${narrativeHtml}
  ${otherReviewsHtml}
  ${bottomCtaHtml}

  <div style="text-align:center;padding:16px 0 8px;font-size:11px;color:#94a3b8;line-height:1.8;">
    Already Done · <a href="https://alreadydone.uk" style="color:#94a3b8;">alreadydone.uk</a><br>
    ${esc(domain)} is hosted by Already Done. <a href="mailto:dean@alreadydone.uk" style="color:#94a3b8;">Contact us</a>.
  </div>

</div>
</body>
</html>`;
}
