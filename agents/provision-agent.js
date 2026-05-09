import { supabase, logInteraction } from '../lib/db.js';
import { checkDomain, registerDomain, pointToCloudflarePages, pollUntilLive } from '../lib/domains.js';
import { addEmailDnsRecords, provisionEmailAddresses } from '../lib/email-provisioning.js';
import { sendOnboardingStarted, sendOnboardingComplete } from '../lib/mailer.js';
import { generateExtraPageSection } from '../lib/claude.js';
import { captureSnapshot } from '../lib/report-data.js';
import { alert } from '../lib/slack.js';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import 'dotenv/config';

const CF_ACCOUNT_ID = 'c663467f92484cce5de42806e1a1e868';
const PAGES_PROJECT_PREFIX = 'ad-customer-';

export async function runProvisionAgent() {
  const { data: paid, error } = await supabase
    .from('businesses')
    .select(`
      id, name, category, location, email, customer_email, customer_first_name,
      template_html, site_slug, stripe_session_id,
      order_domain, order_tier, order_email_count, order_email_prefixes,
      order_include_report, order_pages,
      registered_domain
    `)
    .eq('pipeline_status', 'paid')
    .order('paid_at', { ascending: true })
    .limit(5);

  if (error) throw error;
  if (!paid?.length) {
    console.log('Provision agent: no paid businesses to provision');
    return { provisioned: 0 };
  }

  console.log(`\nProvisioning ${paid.length} paid business(es)`);
  let provisioned = 0;

  for (const business of paid) {
    try {
      await provisionBusiness(business);
      provisioned++;
    } catch (err) {
      console.error(`  Provision failed for ${business.name}: ${err.message}`);
      await logInteraction(business.id, 'error', 'internal', `Provision failed: ${err.message}`, err.stack);
      await alert(`⚠️ Provision failed — ${business.name}\n${err.message}`).catch(() => {});
    }
  }

  return { provisioned };
}

async function provisionBusiness(business) {
  const to = business.customer_email || business.email;
  const firstName = business.customer_first_name || null;
  const emailCount = business.order_email_count || 0;
  const orderPages = business.order_pages ? JSON.parse(business.order_pages) : [];
  const emailPrefixes = business.order_email_prefixes
    ? JSON.parse(business.order_email_prefixes)
    : [];
  const plan = emailCount > 0 ? 'site_and_email' : 'site_only';

  if (!to) throw new Error('No email address to send onboarding to');
  if (!business.order_domain) throw new Error('No domain selected by customer — cannot provision');

  console.log(`\n  Provisioning: ${business.name}`);
  console.log(`    Domain: ${business.order_domain} | Emails: ${emailCount} | Extra pages: ${orderPages.length}`);

  // ── 1. Verify and register the customer-chosen domain ─────────────────────
  const domain = business.order_domain;

  if (business.registered_domain === domain) {
    // Idempotency: domain was already registered in a previous (failed) run — skip registration
    console.log(`    Domain already registered (resuming from failed run): ${domain}`);
  } else {
    const check = await checkDomain(domain);
    if (!check.available) {
      throw new Error(`Customer-selected domain ${domain} is no longer available — manual intervention needed`);
    }
    await registerDomain(domain, { costUsd: check.priceUsd });
    console.log(`    Registered: ${domain}`);
  }

  // ── 2. Set email DNS records now (CNAME for the site set after deploy, once we have the hostname) ──
  if (emailCount > 0) {
    await addEmailDnsRecords(domain);
    console.log(`    Email DNS set`);
  }

  // ── 3. Send Email 1 — "we're building it" ─────────────────────────────────
  await sendOnboardingStarted({ to, firstName, domain, emailPrefix: emailPrefixes[0] || 'info', plan });
  console.log(`    Email 1 sent: ${to}`);

  // ── 4. Build extra page sections into the HTML before deploy ───────────────
  let html = business.template_html;
  if (!html) throw new Error('No template_html on business record');

  if (orderPages.length > 0) {
    console.log(`    Building ${orderPages.length} extra page section(s)...`);
    for (const page of orderPages) {
      try {
        const section = await generateExtraPageSection(html, page, business);
        // Inject section before </body> and add nav link
        html = injectSection(html, section, page.type);
        console.log(`    Added section: ${page.type}`);
      } catch (err) {
        console.warn(`    Could not build section "${page.type}": ${err.message} — skipping`);
      }
    }
  }

  // ── 5. Fix contact form email — replace fallback with customer's real email ─
  const contactEmail = emailCount > 0
    ? `${emailPrefixes[0] || 'info'}@${domain}`
    : (to);
  html = html
    .replace(/mailto:dean@alreadydone\.uk/g, `mailto:${contactEmail}`)
    .replace(/action="mailto:[^"]*"/g, `action="mailto:${contactEmail}"`);

  // ── 6. Deploy site to Cloudflare Pages ────────────────────────────────────
  const projectName = `${PAGES_PROJECT_PREFIX}${business.site_slug || business.id}`.slice(0, 63);
  const tmpDir = `/tmp/provision-${business.id}`;
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(`${tmpDir}/index.html`, html);

  console.log(`    Deploying to Cloudflare Pages (${projectName})...`);
  const deployOutput = execSync(
    `CLOUDFLARE_API_TOKEN="${process.env.CLOUDFLARE_TOKEN}" CLOUDFLARE_ACCOUNT_ID="${CF_ACCOUNT_ID}" npx wrangler pages deploy "${tmpDir}" --project-name="${projectName}"`,
    { encoding: 'utf8', timeout: 120000 }
  );

  rmSync(tmpDir, { recursive: true, force: true });

  const pagesHostnameMatch = deployOutput.match(/https?:\/\/([a-z0-9-]+\.pages\.dev)/);
  const pagesHostname = pagesHostnameMatch?.[1];
  if (!pagesHostname) throw new Error(`Could not extract pages.dev hostname from wrangler output:\n${deployOutput}`);
  console.log(`    Pages live: ${pagesHostname}`);

  // ── 7. Point domain CNAME at the Pages project ────────────────────────────
  await pointToCloudflarePages(domain, pagesHostname);
  console.log(`    DNS CNAME: ${domain} → ${pagesHostname}`);

  // Add custom domain to Pages project
  await addCustomDomainToPages(projectName, domain);

  // ── 8. Update DB — mark delivering ────────────────────────────────────────
  await supabase.from('businesses').update({
    pipeline_status: 'delivering',
    registered_domain: domain,
    pages_hostname: pagesHostname,
    pages_project_name: projectName,
  }).eq('id', business.id);

  // ── 9. Provision email addresses ──────────────────────────────────────────
  let emailAccounts = [];
  if (emailCount > 0) {
    console.log(`    Provisioning ${emailCount} email address(es)...`);
    emailAccounts = await provisionEmailAddresses(domain, emailCount, emailPrefixes);
    console.log(`    Email provisioned: ${emailAccounts.map(a => a.address).join(', ')}`);
  }

  // ── 10. Poll until live ───────────────────────────────────────────────────
  console.log(`    Waiting for ${domain} to go live...`);
  const isLive = await pollUntilLive(domain, { maxAttempts: 30, intervalMs: 60000 });
  if (!isLive) console.warn(`    ${domain} not yet live — sending Email 2 anyway`);

  // ── 11. Send Email 2 — "everything is live" ───────────────────────────────
  await sendOnboardingComplete({
    to,
    firstName,
    domain,
    emailPrefix: emailAccounts[0]?.prefix || null,
    emailPassword: emailAccounts[0]?.password || null,
    plan,
    extraAccounts: emailAccounts.slice(1), // additional addresses if >1
  });
  console.log(`    Email 2 sent: ${to}${emailCount > 0 ? ` + ${contactEmail}` : ''}`);

  // ── 12. Mark delivered ────────────────────────────────────────────────────
  await supabase.from('businesses').update({
    pipeline_status: 'delivered',
    delivered_at: new Date().toISOString(),
  }).eq('id', business.id);

  await logInteraction(
    business.id,
    'site_delivered',
    'internal',
    `Site delivered. Domain: ${domain}${emailCount > 0 ? ` | ${emailCount} email(s) provisioned` : ''}`,
    null,
    { domain, pagesHostname, to, emailAccounts: emailAccounts.map(a => a.address), extraPages: orderPages.length }
  );

  // ── 13. Capture baseline data snapshot for reports ────────────────────────
  try {
    await captureSnapshot({ ...business, registered_domain: domain }, 'baseline');
  } catch (err) {
    console.warn(`    Snapshot failed (non-fatal): ${err.message}`);
  }

  const emailNote = emailCount > 0 ? ` + ${emailCount} email(s)` : '';
  const pagesNote = orderPages.length > 0 ? ` + ${orderPages.length} extra page(s)` : '';
  await alert(`🚀 Delivered — ${business.name}\nhttps://${domain}${emailNote}${pagesNote}`).catch(() => {});
  console.log(`    ✓ ${business.name} → https://${domain}`);
}

// Inject a new <section> before </body> and add a nav link before </nav>
function injectSection(html, sectionHtml, pageType) {
  const navLabel = pageType.charAt(0).toUpperCase() + pageType.slice(1);
  const sectionId = pageType.toLowerCase().replace(/\s+/g, '-');

  // Add nav link before </nav>
  const navLink = `<a href="#${sectionId}">${navLabel}</a>`;
  let result = html.replace(/<\/nav>/i, `  ${navLink}\n</nav>`);

  // Inject section before </body>
  result = result.replace(/<\/body>/i, `\n${sectionHtml}\n</body>`);

  return result;
}

async function addCustomDomainToPages(projectName, domain) {
  if (!process.env.CLOUDFLARE_TOKEN) {
    console.warn('    CLOUDFLARE_TOKEN not set — skipping custom domain API call');
    return;
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${projectName}/domains`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CLOUDFLARE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: domain }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    if (!body.includes('already exists')) {
      console.warn(`    Cloudflare custom domain API: ${res.status}: ${body}`);
    }
  } else {
    console.log(`    Custom domain ${domain} added to Pages project`);
  }
}
