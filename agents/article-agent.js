import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/db.js';
import 'dotenv/config';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: globalThis.fetch });

const TYPE_ORDER = ['top5', 'questions', 'guide', 'costs'];

const TYPE_LABELS = {
  top5:      'Top 5',
  questions: 'Questions to Ask',
  guide:     'Choosing Guide',
  costs:     'Cost Guide',
};

const PRIORITY_AREAS = [
  'edinburgh', 'glasgow', 'aberdeen', 'dundee', 'inverness',
  'stirling', 'perth', 'falkirk', 'livingston',
];

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function pluralize(name) {
  if (/s$|ing$|ness$|ance$|ence$|ery$/.test(name.toLowerCase())) return name;
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
  return name + 's';
}

// How you engage with this type of business — avoids "hire a barber" awkwardness
function categoryAction(name) {
  const lower = name.toLowerCase();
  if (/barber|hair|beauty|beautician|nail|spa|massage|tattoo|therapist|counsellor/.test(lower)) return 'book';
  if (/solicitor|accountant|financial|adviser|advisor|mortgage|optician|dentist|gp|doctor/.test(lower)) return 'instruct';
  return 'hire';
}

function estimateReadingTime(html) {
  const wordCount = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round(wordCount / 200));
}

function extractExcerpt(bodyHtml) {
  const match = bodyHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (match) {
    const text = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return text.length > 220 ? text.slice(0, 220).replace(/\s+\S*$/, '') + '...' : text;
  }
  const text = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 220).replace(/\s+\S*$/, '') + '...';
}

// ── Target selection ─────────────────────────────────────────────────────────

async function getExistingArticles() {
  const { data } = await supabase
    .from('fl_articles')
    .select('article_type, category_slug, area_slug');
  return data || [];
}

async function getMajorAreas() {
  const { data } = await supabase
    .from('areas')
    .select('id, slug, name')
    .in('slug', PRIORITY_AREAS);
  return data || [];
}

async function getTopCategories(limit = 30) {
  const { data } = await supabase.rpc('get_top_category_counts', { lim: limit });
  if (!data?.length) return [];
  const ids = data.map(r => r.fl_category_id);
  const { data: cats } = await supabase
    .from('categories')
    .select('id, slug, name')
    .in('id', ids);
  const countMap = Object.fromEntries(data.map(r => [r.fl_category_id, Number(r.cnt)]));
  return (cats || [])
    .map(c => ({ ...c, count: countMap[c.id] || 0 }))
    .sort((a, b) => b.count - a.count);
}

async function getBusinessCountForCombo(areaId, categoryId) {
  const { count } = await supabase
    .from('businesses')
    .select('*', { count: 'exact', head: true })
    .eq('fl_area_id', areaId)
    .eq('fl_category_id', categoryId)
    .not('fl_slug', 'is', null)
    .eq('business_status', 'OPERATIONAL');
  return count || 0;
}

async function pickTarget(existing) {
  const written = new Set(existing.map(a => `${a.article_type}|${a.category_slug}|${a.area_slug || ''}`));

  const counts = { top5: 0, questions: 0, guide: 0, costs: 0 };
  for (const a of existing) counts[a.article_type] = (counts[a.article_type] || 0) + 1;
  const nextType = TYPE_ORDER.slice().sort((a, b) => counts[a] - counts[b])[0];

  const [areas, categories] = await Promise.all([getMajorAreas(), getTopCategories(30)]);

  if (nextType === 'top5') {
    for (const area of areas) {
      for (const cat of categories) {
        const key = `top5|${cat.slug}|${area.slug}`;
        if (written.has(key)) continue;
        const count = await getBusinessCountForCombo(area.id, cat.id);
        if (count >= 5) return { type: 'top5', area, category: cat, businessCount: count };
      }
    }
  }

  for (const cat of categories) {
    const key = `${nextType}|${cat.slug}|`;
    if (!written.has(key)) return { type: nextType, category: cat, area: null };
  }

  for (const type of TYPE_ORDER) {
    for (const cat of categories) {
      const key = `${type}|${cat.slug}|`;
      if (!written.has(key)) return { type, category: cat, area: null };
    }
  }

  return null;
}

// ── Business data ────────────────────────────────────────────────────────────

async function getTop5Businesses(area, category) {
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, fl_slug, google_rating, review_count, short_address, address, phone, editorial_summary, fl_description, google_reviews')
    .eq('fl_area_id', area.id)
    .eq('fl_category_id', category.id)
    .not('fl_slug', 'is', null)
    .eq('business_status', 'OPERATIONAL')
    .order('fl_quality_score', { ascending: false })
    .limit(5);
  return biz || [];
}

async function getRelatedArticles(target, limit = 3) {
  const orFilters = [];
  if (target.category?.slug) orFilters.push(`category_slug.eq.${target.category.slug}`);
  if (target.area?.slug)     orFilters.push(`area_slug.eq.${target.area.slug}`);
  if (!orFilters.length) return [];

  const { data } = await supabase
    .from('fl_articles')
    .select('slug, title, article_type')
    .or(orFilters.join(','))
    .order('published_at', { ascending: false })
    .limit(limit);
  return data || [];
}

// ── Prompt builders ──────────────────────────────────────────────────────────

const FORMATTING_RULES = `
Formatting rules (important):
- HTML body only — do NOT include <h1>, <html>, <head>, <body>, or <article> tags. The title is displayed by the page separately.
- Use <h2> for all section headings
- Use <ul><li> for lists and checklists — don't write everything as prose paragraphs
- Use <blockquote> for a single key tip or important callout (1–2 per article max)
- Use <strong> to highlight important terms or verdicts
- Links: use <a href="..."> with descriptive anchor text — never just "click here"
- No em dashes. No "dive into", "delve", "tapestry", "navigate", "landscape", "bustling", or AI clichés
- British English throughout
`.trim();

function buildTop5Prompt(target, businesses, related) {
  const { area, category } = target;
  const plural = pluralize(category.name);

  // Business names/ratings given as context so the intro can reference them
  const bizSummary = businesses.map((b, i) =>
    `${i + 1}. ${b.name} — ${b.google_rating ? `${b.google_rating}★ (${b.review_count} reviews)` : 'unrated'} — ${b.short_address || b.address || area.name}`
  ).join('\n');

  const relatedLinks = related.length
    ? related.map(a => `- ${a.title}: /articles/${a.slug}`).join('\n')
    : '';

  return `Write supporting content for a "Top 5 ${plural} in ${area.name}" article on Found Local, a local business directory.

The page already renders the individual business cards (name, photo, rating, address, description, link).
Your job is to write ONLY:
1. The intro section (before the business listings)
2. The "What to look for" advice section (after the listings)
3. A closing CTA paragraph

The 5 featured businesses are:
${bizSummary}

${relatedLinks ? `Related articles you can link to:\n${relatedLinks}\n` : ''}
${FORMATTING_RULES}

Write exactly this structure — nothing more:

[INTRO]
A single paragraph (3–4 sentences) about what makes a great ${category.name.toLowerCase()} in ${area.name} and why it matters. Be direct and specific. Mention that the five below are Edinburgh's highest-rated based on verified customer reviews.

[WHAT TO LOOK FOR]
<h2>What to look for in a ${category.name}</h2>
A <ul> of 5–6 concrete things to check when choosing a ${category.name.toLowerCase()} in Scotland (qualifications, insurance, reviews, communication, pricing transparency, etc.)

[CLOSING]
A short paragraph (2 sentences): "Find more ${plural.toLowerCase()} in ${area.name}" with a link to <a href="/${area.slug}/${category.slug}">all ${plural.toLowerCase()} in ${area.name}</a>.
${relatedLinks ? '\nThen a "Related guides" <h2> with <ul> links to the related articles.' : ''}

No per-business writeups — those are handled by the page. No em dashes. British English.`;
}

function buildQuestionsPrompt(target, related) {
  const { category } = target;
  const action = categoryAction(category.name);
  const actionPhrase = action === 'book' ? `book a ${category.name.toLowerCase()}` :
                       action === 'instruct' ? `instruct a ${category.name.toLowerCase()}` :
                       `hire a ${category.name.toLowerCase()}`;

  const relatedLinks = related.length
    ? related.map(a => `- ${a.title}: /articles/${a.slug}`).join('\n')
    : '';

  return `Write a practical guide titled "Questions to Ask When Choosing a ${category.name}" for Found Local, a local business directory covering Edinburgh and Scotland.

${relatedLinks ? `Related articles you can link to:\n${relatedLinks}\n` : ''}
${FORMATTING_RULES}

Article structure:
1. Intro paragraph (2–3 sentences): why asking the right questions before you ${actionPhrase} matters — be direct, no waffle
2. 7–8 questions as <h2> headings (numbered: "1. Do you carry public liability insurance?")
   - Each with a paragraph explaining WHY you ask it and what a good answer looks like
   - Include UK/Scotland-specific context where relevant (Gas Safe registration, Part P electrical, SVQ qualifications, Scottish building warrants, etc.)
3. A <blockquote> tip for the single most important question
4. A quick-reference <ul> "Checklist at a glance" — just the question text, no explanations, so people can screenshot it
5. Final paragraph: link to <a href="/edinburgh/${category.slug}">find a trusted ${category.name.toLowerCase()} in Edinburgh</a>
${relatedLinks ? '6. A "Related guides" <h2> section with <ul> links to related articles' : ''}

Target length: 700–900 words.`;
}

function buildGuidePrompt(target, related) {
  const { category } = target;
  const action = categoryAction(category.name);
  const actionPhrase = action === 'book' ? `a ${category.name.toLowerCase()}` :
                       `a ${category.name.toLowerCase()}`;

  const relatedLinks = related.length
    ? related.map(a => `- ${a.title}: /articles/${a.slug}`).join('\n')
    : '';

  return `Write a practical "How to Choose a ${category.name}" guide for Found Local, a local business directory covering Edinburgh and Scotland.

${relatedLinks ? `Related articles you can link to:\n${relatedLinks}\n` : ''}
${FORMATTING_RULES}

Article structure:
1. Intro paragraph (2–3 sentences): what's at stake when choosing ${actionPhrase} and what separates a good one from a bad one
2. 5–6 <h2> sections covering:
   - What to check before booking (credentials, insurance, reviews)
   - Qualifications and certifications to look for (be specific to Scotland/UK)
   - How to compare quotes properly
   - Red flags to watch out for (as a <ul> list)
   - What a good job/service looks like
   - (Optional) Online reviews — how to read them
3. A <blockquote> with a key tip or reality check
4. Final CTA paragraph: "Ready to find ${actionPhrase}?" with link to <a href="/edinburgh/${category.slug}">trusted ${category.name.toLowerCase()} in Edinburgh</a>
${relatedLinks ? '5. A "Related guides" <h2> section with <ul> links to related articles' : ''}

Target length: 700–900 words. Scotland-specific throughout where relevant.`;
}

function buildCostsPrompt(target, related) {
  const { category } = target;
  const relatedLinks = related.length
    ? related.map(a => `- ${a.title}: /articles/${a.slug}`).join('\n')
    : '';

  return `Write a practical cost guide titled "How Much Does a ${category.name} Cost in Edinburgh?" for Found Local, a local business directory covering Edinburgh and Scotland.

${relatedLinks ? `Related articles you can link to:\n${relatedLinks}\n` : ''}
${FORMATTING_RULES}

Article structure:
1. Intro paragraph (2–3 sentences): why costs vary and what this guide covers
2. A "Typical price ranges" <h2> section — use a <ul> with realistic GBP figures for Scotland (not London prices). Format each item as: <li><strong>Service type:</strong> £X–£Y per [unit]</li>
3. "What affects the price" <h2> section — <ul> of 4–5 factors (complexity, location, materials, emergency rates, etc.)
4. "How to get a fair quote" <h2> section — practical advice in prose + tips as <ul>
5. "Is cheaper always worse?" <h2> section — honest take (2–3 paragraphs, not a cop-out answer)
6. A <blockquote> with a money-saving tip or warning
7. Final CTA: link to <a href="/edinburgh/${category.slug}">find a trusted ${category.name.toLowerCase()} in Edinburgh</a>
${relatedLinks ? '8. A "Related guides" <h2> section with <ul> links to related articles' : ''}

Target length: 700–900 words. Be honest about Scottish pricing — most trades are cheaper here than London but not dramatically so.`;
}

// ── Claude generation ────────────────────────────────────────────────────────

async function generateArticleHtml(prompt) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
    system: `You are a practical, no-nonsense writer for a Scottish local business directory.
Write genuinely useful content for people looking for local tradespeople and businesses in Scotland and Edinburgh.
Be specific and concrete — vague generalities waste the reader's time.
Match the verb to the service: people "book" a barber or beautician, "hire" a plumber or electrician, "instruct" a solicitor.
Never use em dashes. Never use: "dive into", "delve", "tapestry", "navigate", "landscape", "bustling", "vibrant", "unlock", "seamless", "elevate", or other AI clichés.
Do not start the article with an <h1> tag. The page already displays the title — start with your first <p> intro paragraph.`,
  });
  return msg.content[0].text.trim();
}

function buildArticleSlug(type, category, area) {
  switch (type) {
    case 'top5':      return slugify(`top-5-${pluralize(category.name)}-in-${area.name}`);
    case 'questions': return slugify(`questions-to-ask-when-choosing-a-${category.name}-in-edinburgh`);
    case 'guide':     return slugify(`how-to-choose-a-${category.name}-in-edinburgh`);
    case 'costs':     return slugify(`cost-of-${category.name}-in-edinburgh`);
    default:          return slugify(`${type}-${category.name}`);
  }
}

function buildTitle(type, category, area) {
  switch (type) {
    case 'top5':      return `Top 5 ${pluralize(category.name)} in ${area.name}`;
    case 'questions': return `Questions to Ask When Choosing a ${category.name} in Edinburgh`;
    case 'guide':     return `How to Choose a ${category.name} in Edinburgh`;
    case 'costs':     return `How Much Does a ${category.name} Cost in Edinburgh?`;
    default:          return `${TYPE_LABELS[type]}: ${category.name}`;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runArticleAgent() {
  console.log('\n[Article Agent] Selecting target...');

  const existing = await getExistingArticles();
  const target = await pickTarget(existing);

  if (!target) {
    console.log('[Article Agent] No new article targets — all major combos covered.');
    return { generated: false };
  }

  const { type, category, area } = target;
  const title = buildTitle(type, category, area);
  const slug  = buildArticleSlug(type, category, area);

  const { data: exists } = await supabase.from('fl_articles').select('id').eq('slug', slug).single();
  if (exists) {
    console.log(`[Article Agent] Slug already exists: ${slug} — skipping`);
    return { generated: false };
  }

  console.log(`[Article Agent] Writing: "${title}" (${slug})`);

  const related = await getRelatedArticles(target);
  let prompt;

  if (type === 'top5') {
    const businesses = await getTop5Businesses(area, category);
    if (businesses.length < 3) {
      console.log(`[Article Agent] Not enough businesses for top5 (${businesses.length}) — skipping`);
      return { generated: false };
    }
    prompt = buildTop5Prompt(target, businesses, related);
    target.featuredSlugs = businesses.map(b => b.fl_slug).filter(Boolean);
  } else if (type === 'questions') {
    prompt = buildQuestionsPrompt(target, related);
  } else if (type === 'guide') {
    prompt = buildGuidePrompt(target, related);
  } else {
    prompt = buildCostsPrompt(target, related);
  }

  const bodyHtml = await generateArticleHtml(prompt);
  const excerpt  = extractExcerpt(bodyHtml);
  const readingTime = estimateReadingTime(bodyHtml);

  const { error } = await supabase.from('fl_articles').insert({
    slug,
    title,
    excerpt,
    body_html:               bodyHtml,
    article_type:            type,
    category_slug:           category.slug,
    category_name:           category.name,
    area_slug:               area?.slug  || null,
    area_name:               area?.name  || null,
    featured_business_slugs: target.featuredSlugs || [],
    reading_time_mins:       readingTime,
  });

  if (error) {
    console.error('[Article Agent] DB error:', error.message);
    return { generated: false, error: error.message };
  }

  console.log(`[Article Agent] Published: ${slug} (${readingTime} min read)`);
  return { generated: true, slug, title };
}

// ── Forced-target generation (for batch runs) ─────────────────────────────────

export async function generateForTarget({ type, categorySlug, areaSlug = null }) {
  const { data: category } = await supabase
    .from('categories').select('id, slug, name').eq('slug', categorySlug).single();
  if (!category) return { generated: false, error: `Category not found: ${categorySlug}` };

  let area = null;
  if (areaSlug) {
    const { data } = await supabase
      .from('areas').select('id, slug, name').eq('slug', areaSlug).single();
    area = data;
    if (!area) return { generated: false, error: `Area not found: ${areaSlug}` };
  }

  const target = { type, category, area };
  const title  = buildTitle(type, category, area);
  const slug   = buildArticleSlug(type, category, area);

  const { data: exists } = await supabase.from('fl_articles').select('id').eq('slug', slug).single();
  if (exists) return { generated: false, slug, skipped: true };

  console.log(`  → Writing: "${title}"`);

  const related = await getRelatedArticles(target);
  let prompt;

  if (type === 'top5') {
    if (!area) return { generated: false, error: 'top5 requires an area' };
    const businesses = await getTop5Businesses(area, category);
    if (businesses.length < 3) return { generated: false, error: `Only ${businesses.length} businesses for top5` };
    prompt = buildTop5Prompt(target, businesses, related);
    target.featuredSlugs = businesses.map(b => b.fl_slug).filter(Boolean);
  } else if (type === 'questions') {
    prompt = buildQuestionsPrompt(target, related);
  } else if (type === 'guide') {
    prompt = buildGuidePrompt(target, related);
  } else {
    prompt = buildCostsPrompt(target, related);
  }

  const bodyHtml   = await generateArticleHtml(prompt);
  const excerpt    = extractExcerpt(bodyHtml);
  const readingTime = estimateReadingTime(bodyHtml);

  const { error } = await supabase.from('fl_articles').insert({
    slug, title, excerpt,
    body_html:               bodyHtml,
    article_type:            type,
    category_slug:           category.slug,
    category_name:           category.name,
    area_slug:               area?.slug  || null,
    area_name:               area?.name  || null,
    featured_business_slugs: target.featuredSlugs || [],
    reading_time_mins:       readingTime,
  });

  if (error) return { generated: false, error: error.message };
  return { generated: true, slug, title };
}
