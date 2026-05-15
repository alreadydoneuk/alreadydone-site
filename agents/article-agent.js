import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/db.js';
import 'dotenv/config';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: globalThis.fetch });

// Rotation order — each day writes one article, cycling through types
const TYPE_ORDER = ['top5', 'questions', 'guide', 'costs'];

const TYPE_LABELS = {
  top5:      'Top 5',
  questions: 'Questions to Ask',
  guide:     'Choosing Guide',
  costs:     'Cost Guide',
};

// Major Scotland areas to prioritise — expanded as coverage grows
const PRIORITY_AREAS = [
  'edinburgh', 'glasgow', 'aberdeen', 'dundee', 'inverness',
  'stirling', 'perth', 'dundee', 'falkirk', 'livingston',
];

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function estimateReadingTime(html) {
  const wordCount = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round(wordCount / 200));
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

  // How many top5s have been written? Use that to decide type rotation
  const top5Count   = existing.filter(a => a.article_type === 'top5').length;
  const questCount  = existing.filter(a => a.article_type === 'questions').length;
  const guideCount  = existing.filter(a => a.article_type === 'guide').length;
  const costsCount  = existing.filter(a => a.article_type === 'costs').length;

  const counts = { top5: top5Count, questions: questCount, guide: guideCount, costs: costsCount };
  // Always do the type with the fewest articles, tie-break by TYPE_ORDER
  const nextType = TYPE_ORDER.slice().sort((a, b) => counts[a] - counts[b])[0];

  const [areas, categories] = await Promise.all([getMajorAreas(), getTopCategories(30)]);

  if (nextType === 'top5') {
    // Find the (area, category) combo with most businesses that has no top5 yet
    for (const area of areas) {
      for (const cat of categories) {
        const key = `top5|${cat.slug}|${area.slug}`;
        if (written.has(key)) continue;
        const count = await getBusinessCountForCombo(area.id, cat.id);
        if (count >= 5) {
          return { type: 'top5', area, category: cat, businessCount: count };
        }
      }
    }
  }

  // For category-level articles (no area), pick a popular category without one
  for (const cat of categories) {
    const key = `${nextType}|${cat.slug}|`;
    if (!written.has(key)) {
      return { type: nextType, category: cat, area: null };
    }
  }

  // Fallback: any unseen combo
  for (const type of TYPE_ORDER) {
    for (const cat of categories) {
      const key = `${type}|${cat.slug}|`;
      if (!written.has(key)) return { type, category: cat, area: null };
    }
  }

  return null;
}

// ── Business data for top5 articles ─────────────────────────────────────────

async function getTop5Businesses(area, category) {
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, fl_slug, fl_category_id, google_rating, review_count, short_address, address, phone, editorial_summary, fl_description, google_reviews')
    .eq('fl_area_id', area.id)
    .eq('fl_category_id', category.id)
    .not('fl_slug', 'is', null)
    .eq('business_status', 'OPERATIONAL')
    .order('fl_quality_score', { ascending: false })
    .limit(5);
  return biz || [];
}

// ── Related articles ─────────────────────────────────────────────────────────

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

// ── Claude generation ────────────────────────────────────────────────────────

function buildTop5Prompt(target, businesses, related) {
  const { area, category } = target;
  const bizList = businesses.map((b, i) => {
    const review = b.google_reviews?.find(r => r.text?.length > 30);
    return [
      `${i + 1}. ${b.name}`,
      `   Rating: ${b.google_rating ? `${b.google_rating} ★ (${b.review_count} reviews)` : 'Not rated'}`,
      `   Address: ${b.short_address || b.address || 'Edinburgh'}`,
      `   About: ${b.fl_description || b.editorial_summary || ''}`,
      review ? `   Review snippet: "${review.text.slice(0, 200)}"` : '',
      `   Listing URL: /${area.slug}/${category.slug}/${b.fl_slug}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const relatedLinks = related.length
    ? related.map(a => `- ${a.title}: /articles/${a.slug}`).join('\n')
    : '';

  return `Write a "Top 5 ${category.name} in ${area.name}" article for Found Local, a Scottish local business directory (foundlocal.uk).

Businesses to feature (in this order):
${bizList}

${relatedLinks ? `Related articles to link to at the end:\n${relatedLinks}` : ''}

Requirements:
- British English throughout
- 650–850 words
- HTML body only — no <html>, <head>, <body>, or <article> wrapper tags
- Intro paragraph: why finding a good ${category.name.toLowerCase()} in ${area.name} matters, any local context
- H2 for each business (include their rank number: "1. Business Name")
- Each business entry: 2–3 sentences on WHY they stand out (draw from rating, reviews, description — be specific, not generic), then their address as a small <p class="text-sm text-gray-500">
- Make every business name a link: <a href="/LISTING_URL">Business Name</a>
- After the 5 listings: a short "What to look for" H2 section (3–4 sentences of practical advice for hiring a ${category.name.toLowerCase()} in Scotland)
- Final paragraph: "Find more ${category.name.toLowerCase()} in ${area.name}" linking to <a href="/${area.slug}/${category.slug}">all ${category.name.toLowerCase()} in ${area.name}</a>
${relatedLinks ? '- "Related guides" H2 at the very end, linking to the related articles provided' : ''}
- No em dashes, no "dive into", no "delve", no AI clichés
- Do not fabricate details not in the data above`;
}

function buildQuestionsPrompt(target, related) {
  const { category } = target;
  const relatedLinks = related.length
    ? related.map(a => `- ${a.title}: /articles/${a.slug}`).join('\n')
    : '';

  return `Write a practical hiring guide titled "Questions to Ask Before Hiring a ${category.name}" for Found Local, a Scottish local business directory.

${relatedLinks ? `Related articles to link to:\n${relatedLinks}` : ''}

Requirements:
- British English
- 600–800 words
- HTML body only (no wrapper tags)
- Brief intro: why asking the right questions matters (2–3 sentences)
- 8 specific questions as H2 headings, each with a short explanation paragraph
- Include Scotland/UK-specific context where relevant (e.g. Gas Safe registration, Part P electrical, Scottish building warrants)
- Final CTA paragraph linking to the category page — use the URL format /[area]/[category-slug] but use /edinburgh/${category.slug} as the example
${relatedLinks ? '- "Related guides" H2 at the very end with links to related articles' : ''}
- No em dashes, no AI clichés`;
}

function buildGuidePrompt(target, related) {
  const { category } = target;
  const relatedLinks = related.length
    ? related.map(a => `- ${a.title}: /articles/${a.slug}`).join('\n')
    : '';

  return `Write a practical "How to Choose a ${category.name}" guide for Found Local, a Scottish local business directory.

${relatedLinks ? `Related articles to link to:\n${relatedLinks}` : ''}

Requirements:
- British English
- 600–800 words
- HTML body only (no wrapper tags)
- Intro: what makes choosing a good ${category.name.toLowerCase()} important (2–3 sentences)
- 5–6 H2 sections covering: what to check before hiring, qualifications/certifications to look for, how to compare quotes, red flags to avoid, what a good job looks like
- Scotland-specific context throughout where relevant
- Final CTA: "Find a trusted ${category.name.toLowerCase()} near you" linking to /edinburgh/${category.slug}
${relatedLinks ? '- "Related guides" H2 at the end' : ''}
- No em dashes, no AI clichés`;
}

function buildCostsPrompt(target, related) {
  const { category } = target;
  const relatedLinks = related.length
    ? related.map(a => `- ${a.title}: /articles/${a.slug}`).join('\n')
    : '';

  return `Write a practical cost guide titled "How Much Does a ${category.name} Cost in Scotland?" for Found Local, a Scottish local business directory.

${relatedLinks ? `Related articles to link to:\n${relatedLinks}` : ''}

Requirements:
- British English
- 600–800 words
- HTML body only (no wrapper tags)
- Intro: why costs vary and what factors affect price
- H2 sections covering: typical price ranges (give realistic GBP figures for Scotland), what affects the cost, how to get a fair quote, whether cheaper is better, VAT and callout charges
- Be realistic about Scottish pricing — not London prices
- Final CTA: "Find a ${category.name.toLowerCase()} near you" linking to /edinburgh/${category.slug}
${relatedLinks ? '- "Related guides" H2 at the end' : ''}
- No em dashes, no AI clichés`;
}

async function generateArticleHtml(prompt) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
    system: 'You are a practical, no-nonsense writer for a UK local business directory. Write clear, helpful content for people looking for local tradespeople and businesses in Scotland. Never use em dashes. Never use phrases like "dive into", "delve", "tapestry", "navigate", "landscape", or other AI clichés. Write as a knowledgeable local, not a content farm.',
  });
  return msg.content[0].text.trim();
}

function extractExcerpt(bodyHtml) {
  const text = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 200).replace(/\s+\S*$/, '') + '...';
}

function buildArticleSlug(type, category, area) {
  switch (type) {
    case 'top5':      return slugify(`top-5-${category.name}-in-${area.name}`);
    case 'questions': return slugify(`questions-to-ask-a-${category.name}`);
    case 'guide':     return slugify(`how-to-choose-a-${category.name}`);
    case 'costs':     return slugify(`cost-of-${category.name}-in-scotland`);
    default:          return slugify(`${type}-${category.name}`);
  }
}

function buildTitle(type, category, area) {
  switch (type) {
    case 'top5':      return `Top 5 ${category.name} in ${area.name}`;
    case 'questions': return `Questions to Ask Before Hiring a ${category.name}`;
    case 'guide':     return `How to Choose a ${category.name}`;
    case 'costs':     return `How Much Does a ${category.name} Cost in Scotland?`;
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

  // Check slug doesn't already exist (edge case)
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
    body_html:              bodyHtml,
    article_type:           type,
    category_slug:          category.slug,
    category_name:          category.name,
    area_slug:              area?.slug  || null,
    area_name:              area?.name  || null,
    featured_business_slugs: target.featuredSlugs || [],
    reading_time_mins:      readingTime,
  });

  if (error) {
    console.error('[Article Agent] DB error:', error.message);
    return { generated: false, error: error.message };
  }

  console.log(`[Article Agent] Published: ${slug} (${readingTime} min read)`);
  return { generated: true, slug, title };
}
