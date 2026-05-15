import { supabase } from '../lib/db.js';
import { categories } from '../seeds/categories.js';
import 'dotenv/config';

const edinburghLocations = [
  'Edinburgh',
  'Leith', 'Portobello', 'Morningside', 'Stockbridge', 'Newington',
  'Corstorphine', 'Gorgie', 'Dalry', 'Marchmont', 'Bruntsfield',
  'Liberton', 'Gilmerton', 'Craigmillar', 'Newhaven Edinburgh', 'Colinton',
  'Currie', 'Balerno', 'Restalrig', 'Granton', 'Muirhouse',
  'Pilton Edinburgh', 'Silverknowes', 'Juniper Green', 'Slateford',
  'Stenhouse', 'Longstone Edinburgh', 'Pilrig', 'Bonnington Edinburgh',
  'Cramond', 'Seafield Edinburgh',
  // Edinburgh suburbs
  'Musselburgh', 'Dalkeith', 'Bonnyrigg', 'Penicuik', 'Loanhead',
  'Gorebridge', 'Tranent', 'Haddington', 'North Berwick', 'Dunbar',
  'South Queensferry', 'Broxburn', 'Bathgate', 'Armadale', 'Linlithgow',
  'Livingston',
];

console.log(`Seeding Edinburgh queue: ${categories.length} categories × ${edinburghLocations.length} locations = ${categories.length * edinburghLocations.length} combinations`);

const BATCH_SIZE = 500;
let inserted = 0;

const rows = [];
for (const category of categories) {
  for (const location of edinburghLocations) {
    rows.push({ category, location, status: 'pending' });
  }
}

for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);
  const { error } = await supabase
    .from('queue')
    .upsert(batch, { onConflict: 'category,location', ignoreDuplicates: true });
  if (error) {
    console.error(`Batch error at row ${i}:`, error.message);
  } else {
    inserted += batch.length;
    process.stdout.write(`\r  Processed ${inserted}/${rows.length}...`);
  }
}

console.log(`\nDone.`);
