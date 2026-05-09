import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

let _supabase = null;

function getClient() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
    }
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { fetch: globalThis.fetch });
  }
  return _supabase;
}

// Proxy: db.from(...) etc. work transparently
const supabase = new Proxy({}, {
  get(_, prop) {
    return (...args) => getClient()[prop](...args);
  },
});

// getNextQueueItem: area-aware two-step pick.
// If targetArea is provided, only picks from that location.
// Otherwise picks a random category then a random location within it.
export async function getNextQueueItem(targetArea = null) {
  let query = supabase.from('queue').select('category').eq('status', 'pending');
  if (targetArea) query = query.ilike('location', `%${targetArea}%`);

  const { data: cats, error: catError } = await query;
  if (catError) throw catError;
  if (!cats?.length) return null;

  const distinct = [...new Set(cats.map(r => r.category))];
  const category = distinct[Math.floor(Math.random() * distinct.length)];

  let countQuery = supabase
    .from('queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('category', category);
  if (targetArea) countQuery = countQuery.ilike('location', `%${targetArea}%`);

  const { count } = await countQuery;
  if (!count) return null;

  const offset = Math.floor(Math.random() * count);

  let itemQuery = supabase
    .from('queue')
    .select('*')
    .eq('status', 'pending')
    .eq('category', category);
  if (targetArea) itemQuery = itemQuery.ilike('location', `%${targetArea}%`);

  const { data, error } = await itemQuery.range(offset, offset).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

// Returns pending/complete category counts for an area — used for progress reporting.
// Filters by status first (indexed) then ILIKE on the smaller subset — avoids full 771K-row scan.
export async function getAreaProgress(area) {
  const pattern = `%${area}%`;
  const [pendingRes, completeRes, runningRes] = await Promise.all([
    supabase.from('queue').select('*', { count: 'exact', head: true }).eq('status', 'pending').ilike('location', pattern),
    supabase.from('queue').select('*', { count: 'exact', head: true }).eq('status', 'complete').ilike('location', pattern),
    supabase.from('queue').select('*', { count: 'exact', head: true }).eq('status', 'running').ilike('location', pattern),
  ]);
  const pending = pendingRes.count || 0;
  const complete = completeRes.count || 0;
  const running = runningRes.count || 0;
  return { total: pending + complete + running, complete, pending };
}

export async function getVerifiedLeadCount() {
  const { count } = await supabase
    .from('businesses')
    .select('*', { count: 'exact', head: true })
    .in('pipeline_status', ['researched', 'template_built', 'emailed', 'paid', 'delivered']);
  return count || 0;
}

export async function markQueueRunning(id) {
  const { error } = await supabase
    .from('queue')
    .update({ status: 'running', last_run_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function markQueueComplete(id, businessesFound) {
  const { data: current } = await supabase.from('queue').select('times_run').eq('id', id).single();
  const { error } = await supabase
    .from('queue')
    .update({
      status: 'complete',
      businesses_found: businessesFound,
      times_run: (current?.times_run || 0) + 1,
    })
    .eq('id', id);
  if (error) throw error;
}

// Saves every business found — directory listing + prospect flag.
// Never overwrites pipeline_status or commercial fields if the record already exists
// (an existing prospect in the pipeline shouldn't get reset by a new research run).
export async function upsertDirectoryListing(data) {
  // Check if already in DB — if so, only update directory fields, not pipeline state
  const { data: existing } = await supabase
    .from('businesses')
    .select('id, pipeline_status, is_prospect')
    .eq('place_id', data.place_id)
    .single();

  if (existing) {
    // Preserve pipeline state; update everything else (hours may have changed, rating, etc.)
    const { pipeline_status, is_prospect: existingProspect, id } = existing;
    const update = {
      ...data,
      pipeline_status,
      // Only upgrade prospect flag, never downgrade (a previously identified prospect stays a prospect)
      is_prospect: existingProspect || data.is_prospect || false,
      last_verified_at: new Date().toISOString(),
    };
    delete update.place_id; // can't update the conflict key
    const { data: result, error } = await supabase
      .from('businesses')
      .update(update)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return result;
  }

  // New record — insert with defaults
  const { data: result, error } = await supabase
    .from('businesses')
    .insert({ ...data, last_verified_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return result;
}

// Keep upsertBusiness as an alias so site-builder and outreach agents don't break
export async function upsertBusiness(data) {
  return upsertDirectoryListing(data);
}

export async function updateBusiness(id, fields) {
  const { data, error } = await supabase
    .from('businesses')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getBusinessesByStatus(status) {
  // Fetch hot leads first, then warm — cold leads have no email route so skip entirely
  const { data: hot, error: e1 } = await supabase
    .from('businesses')
    .select('*')
    .eq('pipeline_status', status)
    .eq('lead_temperature', 'hot')
    .neq('website_status', 'broken_dns')
    .order('created_at', { ascending: true });

  const { data: warm, error: e2 } = await supabase
    .from('businesses')
    .select('*')
    .eq('pipeline_status', status)
    .eq('lead_temperature', 'warm')
    .neq('website_status', 'broken_dns')
    .order('created_at', { ascending: true });

  if (e1) throw e1;
  if (e2) throw e2;
  return [...(hot || []), ...(warm || [])];
}

export async function logInteraction(businessId, type, direction, summary, raw, metadata = {}) {
  const { error } = await supabase
    .from('interactions')
    .insert({
      business_id: businessId,
      type,
      direction,
      content_summary: summary,
      raw_content: raw,
      metadata,
    });
  if (error) console.error('Failed to log interaction:', error.message);
}

export { supabase };
