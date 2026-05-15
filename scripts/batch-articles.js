import { generateForTarget } from '../agents/article-agent.js';
import { supabase } from '../lib/db.js';
import 'dotenv/config';

const TARGET_SLUGS = [
  'basement-conversion-specialist',
  'pressure-washing-service',
  'mobile-dog-groomer',
  'cleaning-company',
  'mobile-dj',
  'golf-coach',
  'personal-trainer',
  'hair-extensions-specialist',
];

const TYPES = ['questions', 'guide', 'costs', 'top5'];
const AREA_SLUG = 'edinburgh'; // for top5 articles

let generated = 0;
let skipped   = 0;
let failed    = 0;

for (const categorySlug of TARGET_SLUGS) {
  console.log(`\n[${categorySlug}]`);

  for (const type of TYPES) {
    const areaSlug = type === 'top5' ? AREA_SLUG : null;

    // For top5: check Edinburgh has enough businesses first
    if (type === 'top5') {
      const { data: cat } = await supabase.from('categories').select('id').eq('slug', categorySlug).single();
      const { data: area } = await supabase.from('areas').select('id').eq('slug', AREA_SLUG).single();
      if (cat && area) {
        const { count } = await supabase
          .from('businesses')
          .select('*', { count: 'exact', head: true })
          .eq('fl_category_id', cat.id)
          .eq('fl_area_id', area.id)
          .not('fl_slug', 'is', null)
          .eq('business_status', 'OPERATIONAL');
        if (!count || count < 5) {
          console.log(`  → top5 skip: only ${count ?? 0} businesses in Edinburgh`);
          continue;
        }
      }
    }

    try {
      const result = await generateForTarget({ type, categorySlug, areaSlug });
      if (result.skipped) {
        console.log(`  → ${type}: already exists`);
        skipped++;
      } else if (result.generated) {
        console.log(`  ✓ ${type}: published ${result.slug}`);
        generated++;
      } else {
        console.log(`  ✗ ${type}: ${result.error}`);
        failed++;
      }
    } catch (err) {
      console.error(`  ✗ ${type}: ${err.message}`);
      failed++;
    }

    // Small pause between API calls to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }
}

console.log(`\n── Done ──────────────────────────────`);
console.log(`Generated: ${generated}  Skipped: ${skipped}  Failed: ${failed}`);
