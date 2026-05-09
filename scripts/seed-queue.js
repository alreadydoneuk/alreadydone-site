import { supabase } from '../lib/db.js';
import { categories } from '../seeds/categories.js';
import { locations } from '../seeds/locations.js';
import 'dotenv/config';

console.log(`Seeding queue: ${categories.length} categories × ${locations.length} locations = ${categories.length * locations.length} combinations`);

const BATCH_SIZE = 500;
let inserted = 0;
let skipped = 0;

const rows = [];
for (const category of categories) {
  for (const location of locations) {
    rows.push({ category, location, status: 'pending' });
  }
}

// Insert in batches to avoid Supabase payload limits
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);

  const { error } = await supabase
    .from('queue')
    .upsert(batch, { onConflict: 'category,location', ignoreDuplicates: true });

  if (error) {
    console.error(`Batch error at row ${i}:`, error.message);
  } else {
    inserted += batch.length;
    process.stdout.write(`\r  Inserted ${inserted}/${rows.length}...`);
  }
}

console.log(`\nDone. Queue seeded with up to ${inserted} combinations.`);
