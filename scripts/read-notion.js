/**
 * Reads all Notion pages accessible to the integration and prints a summary.
 * Run after sharing pages with the integration in Notion.
 */
import { listAllPages, listAllDatabases, getPageTitle, readPageBlocks, blocksToMarkdown } from '../lib/notion.js';

console.log('Reading all Notion pages...\n');

const [pages, databases] = await Promise.all([listAllPages(), listAllDatabases()]);

console.log(`Found ${pages.length} page(s) and ${databases.length} database(s)\n`);
console.log('─'.repeat(60));

if (pages.length === 0 && databases.length === 0) {
  console.log('No pages visible. Share pages with the integration in Notion:');
  console.log('  Page → ... menu → Connections → [your integration name] → Confirm');
  process.exit(0);
}

// Print database list
for (const db of databases) {
  const title = await getPageTitle(db);
  console.log(`[DATABASE] ${title} (${db.id})`);
}

if (databases.length > 0) console.log('');

// Print each page with full content
for (const page of pages) {
  const title = await getPageTitle(page);
  const parentType = page.parent?.type || 'unknown';
  const parentRef = page.parent?.page_id || page.parent?.database_id || page.parent?.workspace_id || '';
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📄 ${title}`);
  console.log(`   ID: ${page.id}`);
  console.log(`   Parent: ${parentType} ${parentRef}`);
  console.log(`   Last edited: ${page.last_edited_time}`);
  console.log('─'.repeat(60));

  try {
    const blocks = await readPageBlocks(page.id);
    const md = blocksToMarkdown(blocks);
    console.log(md || '(empty page)');
  } catch (e) {
    console.log(`(could not read blocks: ${e.message})`);
  }
}
