import 'dotenv/config';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ── Search / list ─────────────────────────────────────────────────────────────

export async function listAllPages() {
  const results = [];
  let cursor;

  do {
    const res = await notion.search({
      filter: { property: 'object', value: 'page' },
      page_size: 100,
      start_cursor: cursor,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return results;
}

export async function listAllDatabases() {
  const results = [];
  let cursor;

  // Notion v2 search API only accepts 'page' or 'data_source' as filter values
  // Use 'data_source' to fetch databases
  do {
    const res = await notion.search({
      filter: { property: 'object', value: 'data_source' },
      page_size: 100,
      start_cursor: cursor,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return results;
}

// ── Read page content ─────────────────────────────────────────────────────────

export async function getPageTitle(page) {
  const props = page.properties || {};
  for (const key of ['title', 'Name', 'Title']) {
    const prop = props[key];
    if (!prop) continue;
    if (prop.type === 'title' && prop.title?.length > 0) {
      return prop.title.map(t => t.plain_text).join('');
    }
  }
  // Fallback for database title objects
  if (page.title?.length > 0) return page.title.map(t => t.plain_text).join('');
  return '(untitled)';
}

export async function readPageBlocks(pageId) {
  const blocks = [];
  let cursor;

  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

function blockToText(block) {
  const rt = block[block.type]?.rich_text;
  if (!rt?.length) return null;
  return rt.map(t => t.plain_text).join('');
}

export function blocksToMarkdown(blocks) {
  const lines = [];
  for (const b of blocks) {
    const text = blockToText(b);
    switch (b.type) {
      case 'heading_1': lines.push(`# ${text}`); break;
      case 'heading_2': lines.push(`## ${text}`); break;
      case 'heading_3': lines.push(`### ${text}`); break;
      case 'paragraph': lines.push(text || ''); break;
      case 'bulleted_list_item': lines.push(`- ${text}`); break;
      case 'numbered_list_item': lines.push(`1. ${text}`); break;
      case 'to_do': lines.push(`- [${b.to_do?.checked ? 'x' : ' '}] ${text}`); break;
      case 'code': lines.push('```\n' + (text || '') + '\n```'); break;
      case 'quote': lines.push(`> ${text}`); break;
      case 'callout': lines.push(`> ${b.callout?.icon?.emoji || ''} ${text}`); break;
      case 'divider': lines.push('---'); break;
      default: if (text) lines.push(text);
    }
  }
  return lines.join('\n');
}

// ── Write helpers ─────────────────────────────────────────────────────────────

export async function appendToPage(pageId, markdownLines) {
  const children = markdownLines.map(line => ({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [{ type: 'text', text: { content: line } }],
    },
  }));

  await notion.blocks.children.append({ block_id: pageId, children });
}

export async function createPage({ parentPageId, title, content }) {
  const page = await notion.pages.create({
    parent: { page_id: parentPageId },
    properties: {
      title: {
        title: [{ type: 'text', text: { content: title } }],
      },
    },
  });

  if (content?.length) {
    await appendToPage(page.id, content);
  }

  return page;
}

// ── Update AlreadyDone stats page ─────────────────────────────────────────────

const ALREADYDONE_PAGE_ID = '3569baa1-3b7d-81cb-b47f-c4e7fb44b8c8';

export async function updateAlreadyDoneStats({ date, totalBusinesses, prospects, hot, warm, sitesBuilt, emailed }) {
  const text = `Stats updated ${date}: ${totalBusinesses.toLocaleString()} businesses found, ${prospects} prospects (${hot} hot / ${warm} warm), ${sitesBuilt} sites built, ${emailed} emailed.`;
  await notion.blocks.children.append({
    block_id: ALREADYDONE_PAGE_ID,
    children: [{
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
    }],
  });
}

// ── Export raw client for ad-hoc use ─────────────────────────────────────────
export { notion };
