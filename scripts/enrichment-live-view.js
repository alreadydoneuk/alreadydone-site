import http from 'http';
import { supabase } from '../lib/db.js';
import 'dotenv/config';

const PORT = 4321;

// ── Data functions ────────────────────────────────────────────────────────────

async function getOverview() {
  const GHOST = ['none', 'social'];

  const [
    { count: totalBusinesses },
    { count: totalEmailed },
    { count: totalOpened },
    { count: totalClicked },
    { count: totalReplied },
    { count: buildPool },
    { count: enrichQueue },
    { count: excluded },
    { data: temps },
    { data: pipelineRows },
    { data: revRows },
    { data: tokenRows },
    { count: checkoutViewed },
    { count: checkoutDomain },
    { count: checkoutPayment },
    { data: recentBuilt },
  ] = await Promise.all([
    supabase.from('businesses').select('id', { count: 'exact', head: true }),
    supabase.from('businesses').select('id', { count: 'exact', head: true }).not('first_email_sent_at', 'is', null),
    supabase.from('businesses').select('id', { count: 'exact', head: true }).not('email_opened_at', 'is', null),
    supabase.from('businesses').select('id', { count: 'exact', head: true }).not('email_link_clicked_at', 'is', null),
    supabase.from('businesses').select('id', { count: 'exact', head: true }).not('last_reply_at', 'is', null),
    supabase.from('businesses').select('id', { count: 'exact', head: true }).eq('pipeline_status', 'researched').not('email', 'is', null),
    supabase.from('businesses').select('id', { count: 'exact', head: true }).in('website_status', GHOST).is('serper_attempted_at', null),
    supabase.from('businesses').select('id', { count: 'exact', head: true }).eq('pipeline_status', 'excluded'),
    supabase.from('businesses').select('lead_temperature').not('pipeline_status', 'eq', 'excluded').not('lead_temperature', 'is', null),
    supabase.from('businesses').select('pipeline_status').not('pipeline_status', 'is', null),
    supabase.from('finance').select('amount').eq('type', 'revenue'),
    supabase.from('token_usage').select('model,input_tokens,output_tokens'),
    supabase.from('interactions').select('id', { count: 'exact', head: true }).eq('type', 'checkout_viewed'),
    supabase.from('interactions').select('id', { count: 'exact', head: true }).eq('type', 'checkout_domain_selected'),
    supabase.from('interactions').select('id', { count: 'exact', head: true }).eq('type', 'checkout_payment_started'),
    supabase.from('businesses').select('id,name,category,pipeline_status,updated_at').eq('pipeline_status', 'template_built').order('updated_at', { ascending: false }).limit(5),
  ]);

  const tempCount = { hot: 0, warm: 0, cold: 0 };
  for (const b of temps || []) tempCount[b.lead_temperature] = (tempCount[b.lead_temperature] || 0) + 1;

  const pipelineCount = {};
  for (const b of pipelineRows || []) pipelineCount[b.pipeline_status] = (pipelineCount[b.pipeline_status] || 0) + 1;

  const grossGbp = (revRows || []).reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const totalDelivered = pipelineCount['delivered'] || 0;
  const totalPaid = pipelineCount['paid'] || 0;

  let totalUsd = 0;
  for (const row of tokenRows || []) {
    const isHaiku = (row.model || '').includes('haiku');
    totalUsd += (row.input_tokens / 1e6) * (isHaiku ? 0.80 : 3.00)
              + (row.output_tokens / 1e6) * (isHaiku ? 4.00 : 15.00);
  }
  const totalGbp = totalUsd * 0.79;

  return {
    kpi: {
      revenue_gbp: Math.round(grossGbp * 100) / 100,
      sites_live: totalDelivered,
      total_emailed: totalEmailed || 0,
      total_opened: totalOpened || 0,
      total_clicked: totalClicked || 0,
      total_replied: totalReplied || 0,
      build_pool: buildPool || 0,
      enrich_queue: enrichQueue || 0,
      excluded: excluded || 0,
      total_businesses: totalBusinesses || 0,
    },
    engagement: {
      open_rate:  totalEmailed ? Math.round((totalOpened  || 0) / totalEmailed * 100) : 0,
      click_rate: totalEmailed ? Math.round((totalClicked || 0) / totalEmailed * 100) : 0,
      reply_rate: totalEmailed ? Math.round((totalReplied || 0) / totalEmailed * 100) : 0,
    },
    temps: tempCount,
    pipeline: pipelineCount,
    funnel: {
      viewed: checkoutViewed || 0,
      domain_selected: checkoutDomain || 0,
      payment_started: checkoutPayment || 0,
      completed: totalPaid + totalDelivered,
      abandoned: Math.max(0, (checkoutPayment || 0) - totalPaid - totalDelivered),
    },
    costs: {
      total_usd: Math.round(totalUsd * 100) / 100,
      total_gbp: Math.round(totalGbp * 100) / 100,
      per_contact_gbp: totalEmailed ? Math.round((totalGbp / totalEmailed) * 1000) / 1000 : null,
      overhead_pct: grossGbp > 0 ? Math.round((totalGbp / grossGbp) * 1000) / 10 : null,
    },
    recent_built: recentBuilt || [],
  };
}

async function getProgress() {
  const GHOST = ['none', 'social'];
  const [{ count: remaining }, { data: businesses }] = await Promise.all([
    supabase.from('businesses').select('id', { count: 'exact', head: true })
      .in('website_status', GHOST).is('serper_attempted_at', null).is('email', null),
    supabase.from('businesses')
      .select('id,name,email,domain,website_status,pipeline_status,lead_temperature,email_source,updated_at')
      .not('serper_attempted_at', 'is', null)
      .order('updated_at', { ascending: false }).limit(500),
  ]);

  const done     = businesses?.length || 0;
  const excl     = businesses?.filter(b => b.pipeline_status === 'excluded').length || 0;
  const emails   = businesses?.filter(b => b.email).length || 0;
  const phoneOnly = businesses?.filter(b => !b.email && b.pipeline_status !== 'excluded' && b.pipeline_status !== null).length || 0;
  const noContact = businesses?.filter(b => !b.email && (b.pipeline_status === null || b.pipeline_status === 'researched') && b.lead_temperature === 'cold').length || 0;

  return {
    stats: { done, remaining: remaining || 0, excluded: excl, emails, phoneOnly, noContact },
    businesses: businesses || [],
  };
}

async function getPipeline() {
  const today = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: templateBuilt },
    { data: emailed },
    { data: hotQueue },
    { data: warmQueue },
    { data: coldQueue },
  ] = await Promise.all([
    supabase.from('businesses')
      .select('id,name,category,location,email,lead_temperature,email_type,preview_url,updated_at')
      .eq('pipeline_status', 'template_built')
      .order('updated_at', { ascending: false }),

    supabase.from('businesses')
      .select('id,name,category,location,email,lead_temperature,pipeline_status,preview_url,first_email_sent_at,email_opened_at,email_link_clicked_at,last_reply_at')
      .in('pipeline_status', ['emailed','follow_up_sent','engaged','nurturing','payment_pending'])
      .order('first_email_sent_at', { ascending: false })
      .limit(100),

    supabase.from('businesses')
      .select('id,name,category,location,email,email_confidence,email_source')
      .eq('pipeline_status', 'researched').eq('lead_temperature', 'hot').not('email', 'is', null)
      .order('created_at', { ascending: true }).limit(50),

    supabase.from('businesses')
      .select('id,name,category,location,email,email_confidence,email_source')
      .eq('pipeline_status', 'researched').eq('lead_temperature', 'warm').not('email', 'is', null)
      .order('created_at', { ascending: true }).limit(50),

    supabase.from('businesses')
      .select('id,name,category,location,email,email_confidence,email_source')
      .eq('pipeline_status', 'researched').eq('lead_temperature', 'cold').not('email', 'is', null)
      .order('created_at', { ascending: true }).limit(50),
  ]);

  return {
    template_built: templateBuilt || [],
    emailed: emailed || [],
    queue: {
      hot: hotQueue || [],
      warm: warmQueue || [],
      cold: coldQueue || [],
    },
  };
}

async function getActivity() {
  const { data } = await supabase
    .from('interactions')
    .select('type,direction,content_summary,created_at,businesses(name,category,location)')
    .order('created_at', { ascending: false })
    .limit(50);
  return data || [];
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Already Done — Control</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0d0d0d; color: #e0e0e0; font-family: 'Courier New', monospace; font-size: 13px; }

/* ── Nav / tabs ── */
.topbar { display: flex; align-items: center; gap: 0; border-bottom: 1px solid #222; background: #0d0d0d; position: sticky; top: 0; z-index: 10; }
.topbar-title { color: #fff; font-size: 14px; font-weight: bold; letter-spacing: 1px; padding: 12px 20px; border-right: 1px solid #222; white-space: nowrap; }
.tabs { display: flex; }
.tab { padding: 12px 18px; color: #555; cursor: pointer; border-right: 1px solid #1a1a1a; font-size: 12px; letter-spacing: 0.5px; text-transform: uppercase; transition: color 0.2s, background 0.2s; white-space: nowrap; }
.tab:hover { color: #aaa; background: #111; }
.tab.active { color: #fff; background: #141414; border-bottom: 2px solid #4ade80; margin-bottom: -1px; }
.tick { margin-left: auto; color: #444; font-size: 11px; padding: 0 16px; white-space: nowrap; }

/* ── Panels ── */
.panel { display: none; padding: 20px; }
.panel.active { display: block; }

/* ── KPI cards ── */
.kpi-grid { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
.kpi { background: #111; border: 1px solid #222; border-radius: 6px; padding: 14px 18px; min-width: 130px; }
.kpi-label { color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
.kpi-value { font-size: 26px; font-weight: bold; line-height: 1; }
.kpi-sub { color: #444; font-size: 11px; margin-top: 4px; }
.green { color: #4ade80; } .red { color: #f87171; } .yellow { color: #facc15; } .blue { color: #60a5fa; } .purple { color: #c084fc; }

/* ── Three-col panels ── */
.panels-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 20px; }
@media (max-width: 900px) { .panels-row { grid-template-columns: 1fr 1fr; } }
.sub-panel { background: #111; border: 1px solid #222; border-radius: 6px; padding: 16px; }
.sub-panel-title { color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 14px; }

/* ── Rate bars ── */
.rate-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.rate-row:last-child { margin-bottom: 0; }
.rate-label { color: #aaa; font-size: 11px; width: 70px; flex-shrink: 0; }
.rate-bar-wrap { flex: 1; height: 6px; background: #1e1e1e; border-radius: 3px; overflow: hidden; }
.rate-bar { height: 100%; border-radius: 3px; transition: width 0.5s; }
.rate-bar.blue  { background: #60a5fa; }
.rate-bar.green { background: #4ade80; }
.rate-bar.yellow { background: #facc15; }
.rate-pct { font-size: 13px; font-weight: bold; width: 36px; text-align: right; flex-shrink: 0; }
.rate-abs { color: #444; font-size: 11px; width: 50px; text-align: right; flex-shrink: 0; }

/* ── Funnel rows ── */
.funnel-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #1a1a1a; }
.funnel-row:last-child { border-bottom: none; }
.funnel-label { color: #888; font-size: 12px; }
.funnel-val { font-size: 18px; font-weight: bold; }

/* ── Stats bar (enrichment) ── */
.stats { display: flex; gap: 24px; margin-bottom: 16px; padding: 10px 0; border-bottom: 1px solid #222; flex-wrap: wrap; }
.stat { display: flex; flex-direction: column; }
.stat-label { color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
.stat-value { color: #fff; font-size: 20px; font-weight: bold; }
.progress-bar { height: 3px; background: #1e1e1e; border-radius: 2px; margin-bottom: 16px; }
.progress-fill { height: 100%; background: #4ade80; border-radius: 2px; transition: width 0.5s; }

/* ── Tables ── */
.section-title { color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; margin-top: 20px; }
.section-title:first-child { margin-top: 0; }
table { width: 100%; border-collapse: collapse; }
thead th { color: #444; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; padding: 6px 10px; text-align: left; border-bottom: 1px solid #222; background: #111; }
tbody tr { border-bottom: 1px solid #151515; transition: background 0.2s; }
tbody tr:hover { background: #161616; }
tbody tr.new { animation: flash 1.5s ease-out; }
tbody tr.excluded { background: #120a0a; }
tbody tr.excluded:hover { background: #1e0f0f; }
@keyframes flash { 0% { background: #1e3a1e; } 100% { background: transparent; } }
td { padding: 6px 10px; vertical-align: middle; }
.col-num { color: #333; width: 36px; }
.col-name { max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-email { color: #93c5fd; max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-domain { color: #a78bfa; max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-source { color: #444; font-size: 11px; }
.col-temp { font-size: 11px; }
.col-muted { color: #444; font-size: 11px; }

.badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: bold; }
.badge-excl  { background: #2d0a0a; color: #f87171; }
.badge-hot   { background: #0d2e0d; color: #4ade80; }
.badge-warm  { background: #2a1e00; color: #facc15; }
.badge-cold  { background: #1a1a1a; color: #555; }
.badge-phone { background: #1a1a1a; color: #555; }
.badge-built { background: #0d1f3a; color: #60a5fa; }
.badge-emailed { background: #1a1a2e; color: #818cf8; }

/* ── Engage icons ── */
.ei-row { display: flex; gap: 6px; }
.ei { font-size: 13px; opacity: 0.15; }
.ei.on { opacity: 1; }

/* ── Queue section (site build) ── */
.queue-header { display: flex; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
.queue-stat { background: #111; border: 1px solid #222; border-radius: 4px; padding: 8px 14px; }
.queue-stat-label { color: #444; font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; }
.queue-stat-val { font-size: 20px; font-weight: bold; margin-top: 2px; }
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-title">⚡ ALREADY DONE</div>
  <div class="tabs">
    <div class="tab active" onclick="switchTab('overview')">Overview</div>
    <div class="tab" onclick="switchTab('enrichment')">Enrichment</div>
    <div class="tab" onclick="switchTab('sitebuild')">Site Build</div>
    <div class="tab" onclick="switchTab('emails')">Emails</div>
    <div class="tab" onclick="switchTab('activity')">Activity</div>
  </div>
  <div class="tick" id="tick">Connecting...</div>
</div>

<!-- OVERVIEW -->
<div id="panel-overview" class="panel active">
  <div class="kpi-grid" id="kpi-grid"></div>
  <div class="panels-row">
    <div class="sub-panel">
      <div class="sub-panel-title">Email engagement</div>
      <div id="engagement-panel"></div>
    </div>
    <div class="sub-panel">
      <div class="sub-panel-title">Checkout funnel</div>
      <div id="funnel-panel"></div>
    </div>
    <div class="sub-panel">
      <div class="sub-panel-title">API costs</div>
      <div id="costs-panel"></div>
    </div>
  </div>
  <div class="section-title">Lead temperatures (active)</div>
  <div id="temps-panel" style="display:flex;gap:16px;margin-bottom:20px"></div>
  <div class="section-title">Pipeline breakdown</div>
  <div id="pipeline-panel" style="display:flex;gap:12px;flex-wrap:wrap"></div>
</div>

<!-- ENRICHMENT -->
<div id="panel-enrichment" class="panel">
  <div class="stats">
    <div class="stat"><span class="stat-label">Processed</span><span class="stat-value blue" id="s-done">—</span></div>
    <div class="stat"><span class="stat-label">Remaining</span><span class="stat-value" id="s-remaining">—</span></div>
    <div class="stat"><span class="stat-label">Emails found</span><span class="stat-value green" id="s-emails">—</span></div>
    <div class="stat"><span class="stat-label">Excluded</span><span class="stat-value red" id="s-excluded">—</span></div>
    <div class="stat"><span class="stat-label">Phone only</span><span class="stat-value yellow" id="s-phone">—</span></div>
    <div class="stat"><span class="stat-label">No contact</span><span class="stat-value" id="s-none">—</span></div>
  </div>
  <div class="progress-bar"><div class="progress-fill" id="enrich-progress" style="width:0%"></div></div>
  <table>
    <thead><tr>
      <th class="col-num">#</th><th>Name</th><th>Email</th><th>Domain / URL</th><th>Status</th><th>Source</th>
    </tr></thead>
    <tbody id="enrich-rows"></tbody>
  </table>
</div>

<!-- SITE BUILD -->
<div id="panel-sitebuild" class="panel">
  <div class="queue-header" id="build-queue-stats"></div>
  <div class="section-title">Ready to send (template built)</div>
  <table>
    <thead><tr>
      <th class="col-num">#</th><th>Name</th><th>Category</th><th>Email</th><th>Temp</th><th>Built</th><th>Preview</th>
    </tr></thead>
    <tbody id="built-rows"></tbody>
  </table>
  <div class="section-title">Up next — hot queue</div>
  <table>
    <thead><tr>
      <th class="col-num">#</th><th>Name</th><th>Category</th><th>Email</th><th>Confidence</th><th>Source</th>
    </tr></thead>
    <tbody id="hot-rows"></tbody>
  </table>
  <div class="section-title">Up next — warm queue</div>
  <table>
    <thead><tr>
      <th class="col-num">#</th><th>Name</th><th>Category</th><th>Email</th><th>Confidence</th><th>Source</th>
    </tr></thead>
    <tbody id="warm-rows"></tbody>
  </table>
</div>

<!-- EMAILS -->
<div id="panel-emails" class="panel">
  <div class="section-title">In pipeline — emailed & engaged</div>
  <table>
    <thead><tr>
      <th class="col-num">#</th><th>Name</th><th>Category</th><th>Email</th><th>Status</th><th>Engage</th><th>Sent</th><th>Preview</th>
    </tr></thead>
    <tbody id="emailed-rows"></tbody>
  </table>
</div>

<!-- ACTIVITY -->
<div id="panel-activity" class="panel">
  <div class="section-title">Recent 50 events</div>
  <table>
    <thead><tr>
      <th style="width:130px">When</th><th>Business</th><th>Type</th><th>Dir</th><th>Summary</th>
    </tr></thead>
    <tbody id="activity-rows"></tbody>
  </table>
</div>

<script>
let activeTab = 'overview';
let enrichLastIds = new Set();
let enrichRowCount = 0;
let timers = {};

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t, i) => {
    const names = ['overview','enrichment','sitebuild','emails','activity'];
    t.classList.toggle('active', names[i] === name);
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  refreshTab(name);
}

function refreshTab(name) {
  clearTimeout(timers[name]);
  const urls = {
    overview:    '/api/overview',
    enrichment:  '/api/progress',
    sitebuild:   '/api/pipeline',
    emails:      '/api/pipeline',
    activity:    '/api/activity',
  };
  const intervals = {
    overview: 15000, enrichment: 3000, sitebuild: 8000, emails: 8000, activity: 10000,
  };

  fetch(urls[name])
    .then(r => r.json())
    .then(d => {
      if (name === 'overview')   renderOverview(d);
      if (name === 'enrichment') renderEnrichment(d);
      if (name === 'sitebuild')  renderSiteBuild(d);
      if (name === 'emails')     renderEmails(d);
      if (name === 'activity')   renderActivity(d);
      document.getElementById('tick').textContent = 'Updated ' + new Date().toLocaleTimeString();
    })
    .catch(e => { document.getElementById('tick').textContent = 'Error: ' + e.message; })
    .finally(() => {
      if (activeTab === name) timers[name] = setTimeout(() => refreshTab(name), intervals[name]);
    });
}

// ── Overview ─────────────────────────────────────────────────────────────────
function renderOverview(d) {
  const k = d.kpi || {};
  const e = d.engagement || {};
  const f = d.funnel || {};
  const c = d.costs || {};
  const t = d.temps || {};

  const kpis = [
    { label: 'Revenue',        value: '£' + (k.revenue_gbp || 0),  cls: k.revenue_gbp > 0 ? 'green' : '', sub: 'gross' },
    { label: 'Sites Live',     value: k.sites_live || 0,            cls: k.sites_live > 0 ? 'green' : '', sub: 'delivered' },
    { label: 'Outreach Sent',  value: k.total_emailed || 0,         cls: '',                              sub: 'emails sent' },
    { label: 'Opened',         value: k.total_opened || 0,          cls: k.total_opened > 0 ? 'blue' : '', sub: e.open_rate + '% rate' },
    { label: 'Clicked',        value: k.total_clicked || 0,         cls: k.total_clicked > 0 ? 'blue' : '', sub: e.click_rate + '% rate' },
    { label: 'Replied',        value: k.total_replied || 0,         cls: k.total_replied > 0 ? 'yellow' : '', sub: e.reply_rate + '% rate' },
    { label: 'Build Pool',     value: k.build_pool || 0,            cls: (k.build_pool || 0) > 20 ? 'green' : (k.build_pool || 0) > 0 ? 'yellow' : 'red', sub: 'w/ email, queued' },
    { label: 'Enrich Queue',   value: k.enrich_queue || 0,          cls: k.enrich_queue > 0 ? 'yellow' : 'green', sub: 'unenriched ghosts' },
    { label: 'Total Tracked',  value: (k.total_businesses || 0).toLocaleString(), cls: '', sub: k.excluded + ' excluded' },
  ];

  document.getElementById('kpi-grid').innerHTML = kpis.map(kp => \`
    <div class="kpi">
      <div class="kpi-label">\${kp.label}</div>
      <div class="kpi-value \${kp.cls}">\${kp.value}</div>
      \${kp.sub ? '<div class="kpi-sub">' + kp.sub + '</div>' : ''}
    </div>
  \`).join('');

  const sent = k.total_emailed || 0;
  document.getElementById('engagement-panel').innerHTML = [
    { label: 'Open rate',  pct: e.open_rate  || 0, n: k.total_opened  || 0, cls: 'blue' },
    { label: 'Click rate', pct: e.click_rate || 0, n: k.total_clicked || 0, cls: 'blue' },
    { label: 'Reply rate', pct: e.reply_rate || 0, n: k.total_replied || 0, cls: 'yellow' },
  ].map(r => \`
    <div class="rate-row">
      <div class="rate-label">\${r.label}</div>
      <div class="rate-bar-wrap"><div class="rate-bar \${r.cls}" style="width:\${Math.min(r.pct,100)}%"></div></div>
      <div class="rate-pct \${r.cls}">\${r.pct}%</div>
      <div class="rate-abs">\${r.n} / \${sent}</div>
    </div>
  \`).join('');

  document.getElementById('funnel-panel').innerHTML = [
    { label: 'Checkout visited',  val: f.viewed          || 0, cls: '' },
    { label: 'Domain selected',   val: f.domain_selected || 0, cls: '' },
    { label: 'Payment started',   val: f.payment_started || 0, cls: 'yellow' },
    { label: 'Abandoned',         val: f.abandoned       || 0, cls: (f.abandoned || 0) > 0 ? 'red' : '' },
    { label: 'Purchased',         val: f.completed       || 0, cls: (f.completed || 0) > 0 ? 'green' : '' },
  ].map(r => \`
    <div class="funnel-row">
      <div class="funnel-label">\${r.label}</div>
      <div class="funnel-val \${r.cls}">\${r.val}</div>
    </div>
  \`).join('');

  const overPct = c.overhead_pct;
  const overCls = overPct === null ? '' : overPct <= 10 ? 'green' : overPct <= 15 ? 'yellow' : 'red';
  document.getElementById('costs-panel').innerHTML = \`
    <div class="funnel-row">
      <div class="funnel-label">Total API spend</div>
      <div class="funnel-val" style="font-size:16px">£\${(c.total_gbp||0).toFixed(2)}</div>
    </div>
    <div class="funnel-row">
      <div class="funnel-label">Cost per prospect</div>
      <div class="funnel-val" style="font-size:16px">\${c.per_contact_gbp !== null ? '£' + c.per_contact_gbp.toFixed(2) : '—'}</div>
    </div>
    <div class="funnel-row">
      <div class="funnel-label">Overhead</div>
      <div class="funnel-val \${overCls}" style="font-size:16px">\${overPct !== null ? overPct + '%' : '—'}</div>
    </div>
    <div style="margin-top:8px;height:6px;background:#1e1e1e;border-radius:3px;overflow:hidden">
      <div style="height:100%;width:\${overPct !== null ? Math.min(overPct/20*100,100) : 0}%;background:var(--\${overCls||'mid'}, #555);border-radius:3px;transition:width 0.5s"></div>
    </div>
  \`;

  document.getElementById('temps-panel').innerHTML = [
    { label: 'Hot',  val: t.hot  || 0, cls: 'green' },
    { label: 'Warm', val: t.warm || 0, cls: 'yellow' },
    { label: 'Cold', val: t.cold || 0, cls: '' },
  ].map(r => \`
    <div class="queue-stat">
      <div class="queue-stat-label">\${r.label}</div>
      <div class="queue-stat-val \${r.cls}">\${r.val}</div>
    </div>
  \`).join('');

  const p = d.pipeline || {};
  document.getElementById('pipeline-panel').innerHTML = Object.entries(p)
    .sort((a,b) => b[1]-a[1])
    .map(([s,n]) => \`
      <div class="queue-stat">
        <div class="queue-stat-label">\${s}</div>
        <div class="queue-stat-val">\${n}</div>
      </div>
    \`).join('');
}

// ── Enrichment ────────────────────────────────────────────────────────────────
function renderEnrichment(d) {
  const s = d.stats || {};
  document.getElementById('s-done').textContent      = s.done;
  document.getElementById('s-remaining').textContent = s.remaining;
  document.getElementById('s-emails').textContent    = s.emails;
  document.getElementById('s-excluded').textContent  = s.excluded;
  document.getElementById('s-phone').textContent     = s.phoneOnly;
  document.getElementById('s-none').textContent      = s.noContact;

  const total = s.done + s.remaining;
  document.getElementById('enrich-progress').style.width = total > 0 ? (s.done / total * 100) + '%' : '0%';

  const tbody = document.getElementById('enrich-rows');
  const newRows = (d.businesses || []).filter(b => !enrichLastIds.has(b.id));
  for (const b of newRows) {
    enrichLastIds.add(b.id);
    enrichRowCount++;
    const tr = document.createElement('tr');
    tr.className = b.pipeline_status === 'excluded' ? 'excluded new' : 'new';
    const email = b.email || '—';
    const domain = b.domain || '—';
    const src = b.email_source || '—';
    const badge = enrichBadge(b);
    tr.innerHTML =
      '<td class="col-num">' + enrichRowCount + '</td>' +
      '<td class="col-name">' + esc(b.name) + '</td>' +
      '<td class="col-email">' + esc(email) + '</td>' +
      '<td class="col-domain">' + esc(domain) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td class="col-source">' + esc(src) + '</td>';
    tbody.insertBefore(tr, tbody.firstChild);
  }
}

function enrichBadge(b) {
  if (b.pipeline_status === 'excluded') return '<span class="badge badge-excl">✗ EXCL</span>';
  if (b.email) {
    const t = b.lead_temperature;
    if (t === 'hot')  return '<span class="badge badge-hot">★ hot</span>';
    if (t === 'warm') return '<span class="badge badge-warm">★ warm</span>';
    return '<span class="badge badge-cold">' + (t||'?') + '</span>';
  }
  return '<span class="badge badge-phone">phone</span>';
}

// ── Site Build ────────────────────────────────────────────────────────────────
function renderSiteBuild(d) {
  const q = d.queue || {};
  const tb = d.template_built || [];

  document.getElementById('build-queue-stats').innerHTML = [
    { label: 'Ready to send', val: tb.length,              cls: tb.length > 0 ? 'blue' : '' },
    { label: 'Hot queue',     val: (q.hot||[]).length,     cls: 'green' },
    { label: 'Warm queue',    val: (q.warm||[]).length,    cls: 'yellow' },
    { label: 'Cold queue',    val: (q.cold||[]).length,    cls: '' },
    { label: 'Daily cap',     val: '40',                   cls: '' },
  ].map(s => \`
    <div class="queue-stat">
      <div class="queue-stat-label">\${s.label}</div>
      <div class="queue-stat-val \${s.cls}">\${s.val}</div>
    </div>
  \`).join('');

  renderQueueTable('built-rows', tb, (b, i) => {
    const preview = b.preview_url ? '<a href="' + esc(b.preview_url) + '" target="_blank" style="color:#60a5fa">View →</a>' : '—';
    const built = b.updated_at ? fmtDate(b.updated_at) : '—';
    return '<td class="col-num">' + (i+1) + '</td>' +
      '<td class="col-name">' + esc(b.name) + '</td>' +
      '<td class="col-muted">' + esc(b.category||'') + '</td>' +
      '<td class="col-email">' + esc(b.email||'—') + '</td>' +
      '<td>' + tempBadge(b.lead_temperature) + '</td>' +
      '<td class="col-muted">' + built + '</td>' +
      '<td>' + preview + '</td>';
  });

  renderQueueTable('hot-rows', q.hot || [], queueRow);
  renderQueueTable('warm-rows', q.warm || [], queueRow);
}

function queueRow(b, i) {
  return '<td class="col-num">' + (i+1) + '</td>' +
    '<td class="col-name">' + esc(b.name) + '</td>' +
    '<td class="col-muted">' + esc(b.category||'') + '</td>' +
    '<td class="col-email">' + esc(b.email||'—') + '</td>' +
    '<td class="col-muted">' + esc(b.email_confidence||'') + '</td>' +
    '<td class="col-source">' + esc(b.email_source||'') + '</td>';
}

function renderQueueTable(id, rows, rowFn) {
  const tbody = document.getElementById(id);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:#333;padding:12px 10px">—</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((b, i) => '<tr>' + rowFn(b, i) + '</tr>').join('');
}

// ── Emails ────────────────────────────────────────────────────────────────────
function renderEmails(d) {
  const emailed = d.emailed || [];
  const tbody = document.getElementById('emailed-rows');
  if (!emailed.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:#333;padding:12px 10px">No active outreach</td></tr>';
    return;
  }
  tbody.innerHTML = emailed.map((b, i) => {
    const engage = \`<div class="ei-row">
      <span class="ei\${b.email_opened_at ? ' on' : ''}" title="Opened">👁</span>
      <span class="ei\${b.email_link_clicked_at ? ' on' : ''}" title="Clicked">🔗</span>
      <span class="ei\${b.last_reply_at ? ' on' : ''}" title="Replied">💬</span>
    </div>\`;
    const preview = b.preview_url ? '<a href="' + esc(b.preview_url) + '" target="_blank" style="color:#60a5fa;font-size:11px">View →</a>' : '<span style="color:#333">—</span>';
    const sent = b.first_email_sent_at ? fmtDate(b.first_email_sent_at) : '—';
    const statusCls = b.pipeline_status === 'emailed' ? 'badge-emailed' : 'badge-hot';
    return '<tr>' +
      '<td class="col-num">' + (i+1) + '</td>' +
      '<td class="col-name">' + esc(b.name) + '</td>' +
      '<td class="col-muted">' + esc(b.category||'') + '</td>' +
      '<td class="col-email">' + esc(b.email||'—') + '</td>' +
      '<td><span class="badge ' + statusCls + '">' + esc(b.pipeline_status) + '</span></td>' +
      '<td>' + engage + '</td>' +
      '<td class="col-muted">' + sent + '</td>' +
      '<td>' + preview + '</td>' +
      '</tr>';
  }).join('');
}

// ── Activity ──────────────────────────────────────────────────────────────────
function renderActivity(rows) {
  const tbody = document.getElementById('activity-rows');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:#333;padding:12px 10px">No activity</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const biz = r.businesses;
    const name = biz?.name ? esc(biz.name) : '<span style="color:#333">—</span>';
    const sub = biz?.category ? '<br><span style="color:#333;font-size:10px">' + esc(biz.category) + (biz.location ? ', ' + esc(biz.location) : '') + '</span>' : '';
    const dir = r.direction === 'inbound' ? '<span style="color:#4ade80">↙</span>' : '<span style="color:#555">↗</span>';
    return '<tr>' +
      '<td class="col-muted" style="white-space:nowrap">' + fmtDate(r.created_at) + '</td>' +
      '<td class="col-name">' + name + sub + '</td>' +
      '<td style="color:#60a5fa;font-size:11px">' + esc(r.type) + '</td>' +
      '<td>' + dir + '</td>' +
      '<td class="col-muted" style="max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc((r.content_summary||'').slice(0,90)) + '</td>' +
      '</tr>';
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function tempBadge(t) {
  if (t === 'hot')  return '<span class="badge badge-hot">hot</span>';
  if (t === 'warm') return '<span class="badge badge-warm">warm</span>';
  return '<span class="badge badge-cold">' + (t||'cold') + '</span>';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Initial load
refreshTab('overview');
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  const json = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  };

  try {
    if (url.pathname === '/api/progress') {
      json(await getProgress());
    } else if (url.pathname === '/api/overview') {
      json(await getOverview());
    } else if (url.pathname === '/api/pipeline') {
      json(await getPipeline());
    } else if (url.pathname === '/api/activity') {
      json(await getActivity());
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML);
    }
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Already Done control panel → http://localhost:${PORT}`);
});
