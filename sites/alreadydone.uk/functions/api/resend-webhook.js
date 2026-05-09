// Receives Resend webhook events: email.opened, email.clicked, email.bounced, email.delivered.
// Registered in Resend dashboard → Webhooks → Add endpoint.
// URL: https://alreadydone.uk/api/resend-webhook
// Events: email.opened, email.clicked, email.bounced
// Verified via Svix HMAC-SHA256 signature using RESEND_WEBHOOK_SECRET.

async function verifySvix(request, rawBody, secret) {
  const id        = request.headers.get('svix-id');
  const timestamp = request.headers.get('svix-timestamp');
  const signature = request.headers.get('svix-signature');
  if (!id || !timestamp || !signature) return false;

  // Reject payloads older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;

  const toSign = `${id}.${timestamp}.${rawBody}`;
  const keyBytes = Uint8Array.from(atob(secret.replace('whsec_', '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
  const expected = `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;

  return signature.split(' ').some(s => s === expected);
}

async function sb(env, path, method, body) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'PATCH' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(`Supabase ${method} ${path}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export async function onRequestPost(context) {
  const env = context.env;
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response('Webhook secret not configured', { status: 500 });

  const rawBody = await context.request.text();

  const valid = await verifySvix(context.request, rawBody, secret);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return new Response('Bad request', { status: 400 }); }

  const type    = payload?.type;
  const emailId = payload?.data?.email_id;
  if (!type || !emailId) return new Response('OK', { status: 200 });

  // Match to a business via the messageId stored in interactions metadata
  const messageId = `${emailId}@resend.dev`;

  try {
    const rows = await sb(
      env,
      `/rest/v1/interactions?select=business_id&metadata->>messageId=eq.${encodeURIComponent(messageId)}&limit=1`,
      'GET'
    );
    const businessId = rows?.[0]?.business_id;
    if (!businessId) return new Response('OK', { status: 200 });

    const now = new Date().toISOString();

    if (type === 'email.opened') {
      await Promise.all([
        sb(env, `/rest/v1/businesses?id=eq.${businessId}`, 'PATCH', { email_opened_at: now }),
        sb(env, '/rest/v1/interactions', 'POST', {
          business_id: businessId,
          type: 'email_opened',
          direction: 'inbound',
          content_summary: 'Prospect opened the outreach email',
          metadata: { email_id: emailId },
        }),
      ]);
    }

    if (type === 'email.clicked') {
      await Promise.all([
        sb(env, `/rest/v1/businesses?id=eq.${businessId}`, 'PATCH', { email_link_clicked_at: now }),
        sb(env, '/rest/v1/interactions', 'POST', {
          business_id: businessId,
          type: 'email_clicked',
          direction: 'inbound',
          content_summary: 'Prospect clicked a link in the outreach email',
          metadata: { email_id: emailId, url: payload?.data?.click?.link },
        }),
      ]);
    }

    if (type === 'email.bounced') {
      await sb(env, '/rest/v1/interactions', 'POST', {
        business_id: businessId,
        type: 'email_bounced',
        direction: 'outbound',
        content_summary: `Email bounced: ${payload?.data?.bounce?.type || 'unknown'}`,
        metadata: { email_id: emailId },
      });
    }
  } catch (err) {
    console.error('resend-webhook:', err.message);
  }

  return new Response('OK', { status: 200 });
}
