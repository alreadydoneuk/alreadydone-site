// One-shot: build preview sites then email each business immediately after deploy.
// Runs interactively — watch progress in terminal.
// Usage: node scripts/run-build-and-email.js

import { getBusinessesByStatus, updateBusiness, logInteraction } from '../lib/db.js';
import { generateSite } from '../lib/claude.js';
import { screenshotSite, generateSlug } from '../lib/screenshot.js';
import { enrichBusinessForSiteBuild } from '../lib/serper-enricher.js';
import { sendOutreachForBusiness } from '../agents/outreach-agent.js';
import { alert } from '../lib/slack.js';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOY_SCRIPT = join(__dirname, 'deploy-site.sh');
const PREVIEW_BASE_URL = 'https://alreadydone.uk/preview';
const TARGET = parseInt(process.env.SITE_BUILD_BATCH_SIZE || '40');

async function main() {
  const businesses = await getBusinessesByStatus('researched');
  const contactable = businesses.filter(b => b.email);

  console.log(`\n════════════════════════════════════════`);
  console.log(`  BUILD + EMAIL — ${new Date().toLocaleTimeString()}`);
  console.log(`  Target: ${TARGET} | Pool: ${contactable.length} contactable`);
  console.log(`════════════════════════════════════════\n`);

  if (!contactable.length) {
    console.log('Nothing to build.');
    process.exit(0);
  }

  let built = 0;
  let emailed = 0;
  let attempted = 0;

  for (const business of contactable) {
    if (built >= TARGET) break;
    attempted++;

    console.log(`\n[${built + 1}/${TARGET}] Building: ${business.name} (${business.category}, ${business.location})`);

    // ── Build ──────────────────────────────────────────────────────────────
    let buildOk = false;
    try {
      const slug = generateSlug(business.name, business.location);
      const serperContext = await enrichBusinessForSiteBuild(business).catch(() => null);

      if (serperContext?.discovered_website) {
        const { url } = serperContext.discovered_website;
        console.log(`  ⚠️  Website found at enrichment: ${url} — excluding`);
        await updateBusiness(business.id, { website_status: 'live', is_prospect: false, pipeline_status: 'excluded' });
        await logInteraction(business.id, 'skip', 'internal', `Excluded at pre-build check — website found: ${url}`, null, serperContext.discovered_website);
        continue;
      }

      if (serperContext?.brief?.one_liner) {
        console.log(`  [brief] "${serperContext.brief.one_liner}"`);
      }

      const html = await generateSite({
        name: business.name, category: business.category, location: business.location,
        address: business.short_address || business.address, postcode: business.postcode,
        google_maps_uri: business.google_maps_uri, phone: business.phone, email: business.email,
        slug, google_rating: business.google_rating, review_count: business.review_count,
        editorial_summary: business.editorial_summary, opening_hours: business.opening_hours,
        attributes: business.attributes, google_reviews: business.google_reviews,
        photo_references: business.photo_references, serper_context: serperContext,
      });

      const { htmlPath, screenshotPath } = await screenshotSite(slug, html, business.name);
      const previewUrl = `${PREVIEW_BASE_URL}/${slug}`;

      await updateBusiness(business.id, {
        site_slug: slug, template_html: html, template_screenshot: screenshotPath,
        preview_url: previewUrl, pipeline_status: 'template_built',
      });
      await logInteraction(business.id, 'site_built', 'internal', `Template site generated. Preview: ${previewUrl}`, null, { slug, htmlPath, screenshotPath, previewUrl });

      // Patch business object so outreach has the fresh preview_url + screenshot
      business.preview_url = previewUrl;
      business.template_screenshot = screenshotPath;
      business.site_slug = slug;
      business.pipeline_status = 'template_built';

      console.log(`  ✓ Built: ${previewUrl}`);
      built++;
      buildOk = true;

    } catch (err) {
      if (err?.code === 'PGRST116') {
        console.log(`  Skipped — no longer in database`);
        continue;
      }
      console.error(`  ✗ Build failed: ${err.message}`);
      await logInteraction(business.id, 'error', 'internal', `Site build failed: ${err.message}`, err.stack);
    }

    if (!buildOk) {
      if (built < TARGET && attempted < contactable.length) await sleep(70000);
      continue;
    }

    // ── Deploy ─────────────────────────────────────────────────────────────
    console.log(`  Deploying...`);
    try {
      execSync(`bash "${DEPLOY_SCRIPT}"`, { stdio: 'pipe' });
      console.log(`  ✓ Deployed`);
    } catch (err) {
      console.error(`  ✗ Deploy failed: ${err.message}`);
      // Don't email if deploy failed — preview URL won't be live
      if (built < TARGET && attempted < contactable.length) await sleep(70000);
      continue;
    }

    // ── Email ──────────────────────────────────────────────────────────────
    console.log(`  Emailing ${business.email}...`);
    try {
      const sent = await sendOutreachForBusiness(business);
      if (sent) {
        emailed++;
        console.log(`  ✓ Email sent (${emailed} total)`);
      } else {
        console.log(`  ↷ Email skipped (held/dropped)`);
      }
    } catch (err) {
      console.error(`  ✗ Email failed: ${err.message}`);
    }

    // ── Rate limit sleep ───────────────────────────────────────────────────
    if (built < TARGET && attempted < contactable.length) {
      console.log(`  Waiting 70s (rate limit)...`);
      await sleep(70000);
    }
  }

  console.log(`\n════════════════════════════════════════`);
  console.log(`  DONE — Built: ${built} | Emailed: ${emailed} | Attempted: ${attempted}`);
  console.log(`════════════════════════════════════════\n`);

  if (built > 0) {
    await alert(`🏗️ Build+email run complete`, `Built: ${built} | Emailed: ${emailed}`).catch(() => {});
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
