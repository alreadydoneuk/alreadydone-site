// Facebook-only enrichment sweep.
// Runs searchFacebook() against every prospect with no email.
// Includes businesses previously attempted by other strategies — Facebook wasn't tried before.
// Does NOT stamp serper_attempted_at on misses — they stay available for full enrichment.
// Updates DB and upgrades temperature on hits.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { isGenericEmailDomain } from '../lib/email-finder.js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { fetch: globalThis.fetch });

// ── Pull strategies directly from directory-finder so we don't re-run all of them ──
// We import the internal Facebook function by temporarily exporting it.
// Since it's not exported, we inline a minimal version here that calls the same Serper + Playwright logic.

import { chromium } from 'playwright';

const SERPER_URL = 'https://google.serper.dev/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SLEEP_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function extractCity(location) {
  if (!location) return '';
  const byComma = location.split(',').map(s => s.trim());
  if (byComma.length >= 2) return byComma[byComma.length - 1];
  return location.trim().split(/\s+/).pop();
}

function extractEmails(text) {
  if (!text) return [];
  const clean = text
    .replace(/\\u003e/gi, '').replace(/&gt;/gi, '').replace(/&#62;/gi, '')
    .replace(/\\u003c/gi, '').replace(/&lt;/gi, '').replace(/&#60;/gi, '');
  const re = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
  const JUNK = new Set(['example.com','domain.com','yourdomain.com','email.com','sentry.io',
    'cloudflare.com','wixpress.com','wixsite.com','wix.com','wordpress.com','squarespace.com',
    'shopify.com','google.com','googleapis.com','facebook.com','instagram.com','tailster.com']);
  const found = [];
  for (const m of clean.matchAll(re)) {
    const email = m[1].toLowerCase();
    const domain = email.split('@')[1] || '';
    if (!JUNK.has(domain) && !email.includes('..') && email.length < 80) found.push(email);
  }
  return [...new Set(found)];
}

function normalisePhone(p) {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  if (digits.startsWith('440')) return '0' + digits.slice(2);
  if (digits.startsWith('44'))  return '0' + digits.slice(2);
  return digits;
}

function phonesMatch(a, b) {
  const na = normalisePhone(a);
  const nb = normalisePhone(b);
  if (!na || !nb || na.length < 9 || nb.length < 9) return false;
  return na.slice(-10) === nb.slice(-10);
}

function normalisePostcode(pc) {
  return (pc || '').toUpperCase().replace(/\s+/g, '');
}

const CONSUMER_DOMAINS = new Set([
  'gmail.com','googlemail.com','hotmail.com','hotmail.co.uk','outlook.com','outlook.co.uk',
  'live.com','live.co.uk','yahoo.com','yahoo.co.uk','icloud.com','me.com','mac.com',
  'btinternet.com','sky.com','talktalk.net','virginmedia.com','ntlworld.com','aol.com','aol.co.uk',
  'protonmail.com','pm.me',
]);

function assessConfidence(text, businessName, phone, postcode, emailDomain) {
  if (phone && phonesMatch(phone, text.replace(/\s/g, ''))) return 'high';
  const pc = normalisePostcode(postcode);
  const postcodeFound = pc.length >= 5 && text.toUpperCase().includes(pc.slice(0, -2));
  const words = businessName.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !['the','and','for','ltd','with'].includes(w));
  const nameFound = words.length > 0 && words.some(w => text.toLowerCase().includes(w));
  if (emailDomain && !CONSUMER_DOMAINS.has(emailDomain)) {
    const domainWords = emailDomain.replace(/\.(com|co\.uk|uk|net|org|io)$/, '').split(/[-_.]+/);
    const bizWords = businessName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const domainMatchesBiz = domainWords.some(dw => dw.length > 3 && bizWords.some(bw => bw.includes(dw) || dw.includes(bw)));
    if (!domainMatchesBiz) return 'low';
    if (nameFound) return 'medium';
    return 'low';
  }
  if (!nameFound || !postcodeFound) return 'low';
  return 'medium';
}

async function googleSearch(query) {
  try {
    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'gb', hl: 'en', num: 10 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.organic || [];
  } catch { return []; }
}

async function fetchHtml(url, timeoutMs = 8000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return res.text();
  } catch { return null; }
}

async function searchFacebook(name, location, phone, postcode) {
  const city = extractCity(location);
  const cleanName = name.replace(/[''']/g, '').replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const queries = [`"${cleanName}" ${city} site:facebook.com`, `${cleanName} ${city} site:facebook.com`];
  const seen = new Set();
  const results = [];
  for (const q of queries) {
    const r = await googleSearch(q);
    for (const item of r) if (!seen.has(item.link)) { seen.add(item.link); results.push(item); }
    if (results.some(r => r.link?.includes('facebook.com/'))) break;
  }

  for (const item of results) {
    const url = item.link || '';
    if (!url.includes('facebook.com/')) continue;
    if (/\/(posts|events|groups|photos|videos|marketplace)\//.test(url)) continue;
    const slug = url.match(/facebook\.com\/([^/?#]+)/)?.[1];
    if (!slug || ['pages', 'pg', 'groups', 'share', 'sharer', 'people'].includes(slug)) continue;

    // Snippet first
    const snippetText = `${item.snippet || ''} ${item.title || ''}`;
    for (const email of extractEmails(snippetText)) {
      const conf = assessConfidence(snippetText, name, phone, postcode, email.split('@')[1]);
      if (conf !== 'low') return { email, confidence: conf, source: 'facebook', profileUrl: url };
    }

    // Mobile About page (no login usually needed)
    const mobileHtml = await fetchHtml(`https://m.facebook.com/${slug}/about`, 10000);
    if (mobileHtml && !mobileHtml.includes('id="login_form"') && !mobileHtml.includes('name="email" placeholder')) {
      for (const email of extractEmails(mobileHtml)) {
        const conf = assessConfidence(mobileHtml, name, phone, postcode, email.split('@')[1]);
        if (conf !== 'low') return { email, confidence: conf, source: 'facebook', profileUrl: url };
      }
    }

    // Playwright fallback
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-GB,en;q=0.9' });
      await page.goto(`https://www.facebook.com/${slug}/about`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);
      const content = await page.content();
      for (const email of extractEmails(content)) {
        const conf = assessConfidence(content, name, phone, postcode, email.split('@')[1]);
        if (conf !== 'low') return { email, confidence: conf, source: 'facebook', profileUrl: url };
      }
    } catch { /* blocked or timeout */ }
    finally { await browser?.close(); }
  }
  return null;
}

// ── Load all no-email prospects ───────────────────────────────────────────────
const { data: businesses } = await db
  .from('businesses')
  .select('id, name, category, location, phone, postcode')
  .eq('is_prospect', true)
  .is('email', null)
  .order('phone', { ascending: false, nullsFirst: false }); // phone-having first — higher hit rate

const total = businesses?.length || 0;
console.log(`\n══════════════════════════════════════════════════`);
console.log(`  Facebook sweep: ${total} no-email prospects`);
console.log(`══════════════════════════════════════════════════\n`);

let found = 0, i = 0;
const hits = [];
const startTime = Date.now();

for (const b of businesses) {
  i++;
  process.stdout.write(`[${i}/${total}] ${b.name} ... `);

  try {
    const result = await searchFacebook(b.name, b.location, b.phone, b.postcode);

    if (result) {
      const emailType = isGenericEmailDomain(result.email) ? 'generic' : 'business';
      const temp = result.confidence === 'high' ? 'hot' : 'warm';
      await db.from('businesses').update({
        email: result.email,
        email_type: emailType,
        email_confidence: result.confidence,
        email_source: result.source,
        lead_temperature: temp,
        outreach_route: 'email',
        serper_attempted_at: new Date().toISOString(),
      }).eq('id', b.id);
      hits.push(`  ${b.name} → ${result.email} [${result.confidence}]`);
      process.stdout.write(`✓ ${result.email} [${result.confidence}]\n`);
      found++;
    } else {
      process.stdout.write(`—\n`);
    }
  } catch (err) {
    process.stdout.write(`error: ${err.message}\n`);
  }

  // Progress every 20 businesses
  if (i % 20 === 0) {
    const pct = Math.round(i / total * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const eta = Math.round((total - i) / (i / elapsed));
    const m = Math.floor(eta / 60), s = eta % 60;
    const hitRate = Math.round(found / i * 100);
    console.log(`\n── ${pct}% | ${i}/${total} done | ${found} found (${hitRate}%) | ETA ${m}m${String(s).padStart(2,'0')}s ──\n`);
  }

  await sleep(SLEEP_MS);
}

const elapsed = Math.round((Date.now() - startTime) / 1000);
console.log(`\n${'═'.repeat(50)}`);
console.log(`DONE — ${total} checked in ${Math.floor(elapsed/60)}m${String(elapsed%60).padStart(2,'0')}s`);
console.log(`Found: ${found} (${Math.round(found/total*100)}%)`);
console.log(`\nAll hits:`);
hits.forEach(h => console.log(h));
