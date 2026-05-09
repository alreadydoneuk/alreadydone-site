// Cloudflare Pages Function — /api/report-track
// Handles email open tracking (pixel) and CTA click tracking for monthly reports.
// GET /api/report-track?id={tracking_id}&e=open
// GET /api/report-track?id={tracking_id}&e=click&r={encoded_dest_url}

const TRANSPARENT_GIF = Uint8Array.from([
  0x47,0x49,0x46,0x38,0x39,0x61,0x01,0x00,0x01,0x00,0x80,0x00,0x00,0xff,0xff,0xff,
  0x00,0x00,0x00,0x21,0xf9,0x04,0x00,0x00,0x00,0x00,0x00,0x2c,0x00,0x00,0x00,0x00,
  0x01,0x00,0x01,0x00,0x00,0x02,0x02,0x44,0x01,0x00,0x3b,
]);

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const trackingId = url.searchParams.get('id');
  const event = url.searchParams.get('e');   // 'open' | 'click'
  const redirect = url.searchParams.get('r'); // destination URL for clicks

  if (trackingId && event && env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    const field = event === 'open' ? 'opened_at' : event === 'click' ? 'cta_clicked_at' : null;
    if (field) {
      // Fire-and-forget — don't block the response
      context.waitUntil(
        fetch(
          `${env.SUPABASE_URL}/rest/v1/report_history?tracking_id=eq.${encodeURIComponent(trackingId)}&${field}=is.null`,
          {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ [field]: new Date().toISOString() }),
          }
        ).catch(() => {})
      );
    }
  }

  // Clicks: redirect to destination
  if (event === 'click' && redirect) {
    return Response.redirect(decodeURIComponent(redirect), 302);
  }

  // Opens: return 1x1 transparent GIF
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
