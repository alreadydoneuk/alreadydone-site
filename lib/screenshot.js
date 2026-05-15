import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(__dirname, '..', 'sites');
const PREVIEW_DIR = join(SITES_DIR, 'alreadydone.uk', 'preview');

export async function screenshotSite(slug, html, businessName) {
  const siteDir = join(SITES_DIR, slug);
  mkdirSync(siteDir, { recursive: true });

  const htmlPath = join(siteDir, 'index.html');
  const screenshotPath = join(siteDir, 'screenshot.png');

  // Local copy — clean, no banner (used for screenshot in email)
  writeFileSync(htmlPath, html, 'utf8');

  // Preview copy — inject claim banner so prospect has a direct CTA when they visit
  const previewDir = join(PREVIEW_DIR, slug);
  mkdirSync(previewDir, { recursive: true });
  writeFileSync(join(previewDir, 'index.html'), injectClaimBanner(html, businessName, slug), 'utf8');

  await withTimeout(30000, async () => {
    const browser = await chromium.launch({ timeout: 10000 });
    const page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await page.waitForTimeout(1000);
      await page.screenshot({ path: screenshotPath, fullPage: false });
    } finally {
      await browser.close();
    }
  }, `Screenshot timeout for ${slug}`);

  return { htmlPath, screenshotPath };
}

function withTimeout(ms, fn, label = 'operation') {
  return Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export function injectClaimBanner(html, businessName, slug) {
  const name = (businessName || 'your business').replace(/"/g, '&quot;');
  const base = (process.env.CHECKOUT_BASE_URL || 'https://alreadydone.uk/checkout').replace(/\/$/, '');
  const checkoutUrl = `${base}?slug=${encodeURIComponent(slug || '')}`;

  const expiryDate = new Date(Date.now() + 14 * 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

  const banner = `
<!-- Already Done claim banner -->
<style>
  #ad-claim-banner { position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e3a5f;color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;font-family:Arial,sans-serif;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.25); }
  #ad-claim-banner span { line-height:1.4; }
  #ad-claim-tagline { font-weight:600;font-size:15px; }
  #ad-claim-expiry { color:#93c5fd;font-size:12px;display:block;margin-top:3px; }
  #ad-claim-btn { background:#f59e0b;color:#1e3a5f;padding:10px 22px;border-radius:5px;text-decoration:none;font-weight:700;white-space:nowrap;font-size:15px;flex-shrink:0;letter-spacing:-0.2px; }
  #ad-claim-btn:hover { background:#fbbf24; }
  @media(max-width:600px){ #ad-claim-banner{flex-direction:column;text-align:center;padding:12px 16px;gap:10px;} #ad-claim-btn{width:100%;text-align:center;display:block;} }
</style>
<div id="ad-claim-banner">
  <span>
    <span id="ad-claim-tagline">Your <strong>${name}</strong> website is ready.</span>
    <small id="ad-claim-expiry">Built by Already Done · £99 to go live · Offer expires ${expiryDate}</small>
  </span>
  <a id="ad-claim-btn" href="${checkoutUrl}">Claim for £99 →</a>
</div>
<div id="ad-banner-spacer"></div>
<script>
(function() {
  function applyBannerOffset() {
    var banner = document.getElementById('ad-claim-banner');
    var spacer = document.getElementById('ad-banner-spacer');
    if (!banner || !spacer) return;
    var h = banner.offsetHeight;
    spacer.style.height = h + 'px';
    // Push any sticky/fixed navs and headers down so they sit below the banner
    var candidates = document.querySelectorAll('nav, header, [class*="nav"], [class*="header"]');
    candidates.forEach(function(el) {
      if (el.id === 'ad-claim-banner') return;
      var s = window.getComputedStyle(el);
      if ((s.position === 'sticky' || s.position === 'fixed') && parseInt(s.top || '0') < 10) {
        el.style.top = h + 'px';
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyBannerOffset);
  } else {
    applyBannerOffset();
  }
  window.addEventListener('resize', applyBannerOffset);
})();
</script>`;

  // Inject immediately after <body> tag
  return html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
}

export function generateSlug(businessName, location) {
  return `${businessName}-${location}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
}
