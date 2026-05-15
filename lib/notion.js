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

// ── Structured page reader ────────────────────────────────────────────────────

// Reads a page and returns its todos with block IDs, grouped by section heading.
// Used by the chronicler to identify which tasks to check off.
export async function readPageTodos(pageId) {
  const blocks = await readPageBlocks(pageId);
  const items = [];
  let currentSection = '';

  for (const b of blocks) {
    if (b.type === 'heading_1' || b.type === 'heading_2' || b.type === 'heading_3') {
      currentSection = (b[b.type]?.rich_text || []).map(t => t.plain_text).join('');
    } else if (b.type === 'to_do') {
      const text = (b.to_do?.rich_text || []).map(t => t.plain_text).join('');
      items.push({
        id: b.id,
        section: currentSection,
        text,
        checked: b.to_do?.checked || false,
      });
    }
  }

  return items;
}

// ── Write helpers ─────────────────────────────────────────────────────────────

// Marks a to_do block as checked.
export async function checkTodoBlock(blockId) {
  await notion.blocks.update({ block_id: blockId, to_do: { checked: true } });
}

// Converts a simple markdown string into an array of Notion block objects.
export function markdownToBlocks(markdown) {
  const blocks = [];
  for (const line of markdown.split('\n')) {
    if (line === '---') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
    } else if (line.startsWith('# ')) {
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: [{ type: 'text', text: { content: line.slice(2) } }] } });
    } else if (line.startsWith('## ')) {
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: line.slice(3) } }] } });
    } else if (line.startsWith('### ')) {
      blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: line.slice(4) } }] } });
    } else if (line.startsWith('- [ ] ')) {
      blocks.push({ object: 'block', type: 'to_do', to_do: { rich_text: [{ type: 'text', text: { content: line.slice(6) } }], checked: false } });
    } else if (/^- \[x\] /i.test(line)) {
      blocks.push({ object: 'block', type: 'to_do', to_do: { rich_text: [{ type: 'text', text: { content: line.slice(6) } }], checked: true } });
    } else if (line.startsWith('- ')) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: line.slice(2) } }] } });
    } else if (line.trim() !== '') {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: line } }] } });
    }
  }
  return blocks;
}

// Appends a dated session note section to a page (e.g. Notes Log).
export async function appendSessionNote(pageId, dateLabel, markdownContent) {
  const blocks = [
    { object: 'block', type: 'divider', divider: {} },
    { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: dateLabel } }] } },
    ...markdownToBlocks(markdownContent),
  ];

  // Notion allows max 100 blocks per append call
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({ block_id: pageId, children: blocks.slice(i, i + 100) });
  }
}

// Appends new unchecked to_do items to a page under an optional heading.
export async function appendTasks(pageId, tasks) {
  if (!tasks?.length) return;
  const blocks = tasks.map(t => ({
    object: 'block',
    type: 'to_do',
    to_do: { rich_text: [{ type: 'text', text: { content: t } }], checked: false },
  }));
  await notion.blocks.children.append({ block_id: pageId, children: blocks });
}

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
