import { addDnsRecord } from './domains.js';
import 'dotenv/config';

const FE_API = 'https://api.forwardemail.net/v1';

const DEFAULT_PREFIXES = ['info', 'hello', 'contact', 'admin', 'enquiries'];

function feHeaders() {
  const key = process.env.FORWARD_EMAIL_API_KEY;
  if (!key) throw new Error('FORWARD_EMAIL_API_KEY not set');
  return {
    Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64'),
    'Content-Type': 'application/json',
  };
}

async function fe(method, path, body = null) {
  const res = await fetch(`${FE_API}${path}`, {
    method,
    headers: feHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const msg = data?.message || data?.error || String(res.status);
    throw new Error(`ForwardEmail ${method} ${path}: ${msg}`);
  }
  return data;
}

// Add all 8 DNS records required for ForwardEmail on a Porkbun-managed domain.
// Call this after domain registration, alongside pointToCloudflarePages.
export async function addEmailDnsRecords(domain) {
  await addDnsRecord(domain, { type: 'MX', name: '', content: 'mx1.forwardemail.net', prio: 10, ttl: 3600 });
  await addDnsRecord(domain, { type: 'MX', name: '', content: 'mx2.forwardemail.net', prio: 20, ttl: 3600 });
  await addDnsRecord(domain, { type: 'TXT', name: '', content: 'v=spf1 include:spf.forwardemail.net -all', ttl: 3600 });
  await addDnsRecord(domain, { type: 'CNAME', name: 'fe-bounces', content: 'forwardemail.net', ttl: 3600 });
  await addDnsRecord(domain, { type: 'CNAME', name: 'fm1._domainkey', content: `fm1.${domain}.dkim.forwardemail.net`, ttl: 3600 });
  await addDnsRecord(domain, { type: 'CNAME', name: 'fm2._domainkey', content: `fm2.${domain}.dkim.forwardemail.net`, ttl: 3600 });
  await addDnsRecord(domain, { type: 'CNAME', name: 'fm3._domainkey', content: `fm3.${domain}.dkim.forwardemail.net`, ttl: 3600 });
  await addDnsRecord(domain, { type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=reject; pct=100;', ttl: 3600 });
  console.log(`[email] DNS records set for ${domain}`);
}

// Provision N IMAP mailboxes on a domain via ForwardEmail API.
// prefixes: array of strings e.g. ['info', 'hello'] — falls back to defaults if empty.
// Returns array of { prefix, address, password } for inclusion in onboarding email.
export async function provisionEmailAddresses(domain, count, prefixes = []) {
  if (!count || count <= 0) return [];

  const resolvedPrefixes = prefixes.length >= count
    ? prefixes.slice(0, count)
    : [...prefixes, ...DEFAULT_PREFIXES].filter((p, i, a) => a.indexOf(p) === i).slice(0, count);

  // 1. Register domain with ForwardEmail
  await fe('POST', '/domains', { domain }).catch(err => {
    // Domain already registered is not an error
    if (!err.message.includes('already')) throw err;
    console.log(`[email] Domain ${domain} already registered with ForwardEmail`);
  });
  console.log(`[email] Domain ${domain} registered`);

  const accounts = [];

  for (const prefix of resolvedPrefixes) {
    // 2. Create alias with IMAP — no recipients field (avoids recursive forwarding error)
    const alias = await fe('POST', `/domains/${domain}/aliases`, {
      name: prefix,
      is_enabled: true,
      has_imap: true,
    });
    console.log(`[email] Alias ${prefix}@${domain} created (id: ${alias.id})`);

    // 3. Generate password
    const pwResult = await fe('POST', `/domains/${domain}/aliases/${alias.id}/generate-password`);
    const password = pwResult.password;
    console.log(`[email] Password generated for ${prefix}@${domain}`);

    accounts.push({ prefix, address: `${prefix}@${domain}`, password });
  }

  return accounts;
}

// Disable all aliases on a domain — call on subscription lapse.
export async function disableEmailAliases(domain) {
  const data = await fe('GET', `/domains/${domain}/aliases`);
  const aliases = (data?.results || []);
  for (const alias of aliases) {
    if (alias.is_enabled) {
      await fe('PUT', `/domains/${domain}/aliases/${alias.id}`, { is_enabled: false });
      console.log(`[email] Disabled ${alias.name}@${domain}`);
    }
  }
}
