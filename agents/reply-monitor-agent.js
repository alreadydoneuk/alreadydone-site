import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { classifyReply, generateProspectReply } from '../lib/claude.js';
import { sendAutoReply } from '../lib/mailer.js';
import { supabase, logInteraction } from '../lib/db.js';
import 'dotenv/config';

const IMAP_HOST = process.env.IMAP_HOST;
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993');
const CHECKOUT_BASE_URL = process.env.CHECKOUT_BASE_URL || 'https://alreadydone.uk/checkout';

// After this many auto-replies in a thread, stop and flag for manual review.
const AUTO_REPLY_CAP = 3;

const STATUS_MAP = {
  '2A': 'payment_pending',
  '2B': 'engaged',
  '2C': 'engaged',
  '2D': 'closed_has_site',
  '2E': 'nurturing',
  '2F': 'engaged',
  '2G': 'suppressed',
  '2H': 'escalated',
  '2I': 'engaged',
  '2J': 'engaged',
};

const FOLLOWUP_DAYS = {
  '2A': 2,
  '2B': 5,
  '2C': 5,
  '2D': null,
  '2E': 5,
  '2F': 5,
  '2G': null,
  '2H': null,
  '2I': 5,
  '2J': 5,
};

export async function runReplyMonitorAgent() {
  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS) {
    console.log('Reply monitor: IMAP not configured');
    return { processed: 0 };
  }

  const messages = await fetchUnseenReplies();
  if (messages.length === 0) {
    console.log('Reply monitor: no new replies');
    return { processed: 0 };
  }

  console.log(`Reply monitor: processing ${messages.length} message(s)`);
  let processed = 0;
  const seenSeqnos = []; // sequence numbers (not UIDs) — same session numbers used by imap.search

  for (const msg of messages) {
    try {
      await processReply(msg);
      processed++;
      // Mark read for anything that processed cleanly — system skips, matched replies, escalations
      if (msg.seqno) seenSeqnos.push(msg.seqno);
    } catch (err) {
      console.error(`  Error processing reply from ${msg.from}: ${err.message}`);
      // Leave unseen — will be retried next run rather than lost
    }
  }

  if (seenSeqnos.length) await markSeqnosSeen(seenSeqnos);

  return { processed };
}

async function processReply(msg) {
  // Already identified as system email in fetchUnseenReplies — skip, mark read
  if (msg._system) return;

  const senderEmail = extractEmail(msg.from);
  if (!senderEmail) return; // malformed — mark read, don't escalate

  // ── Match business using cascade: In-Reply-To → sender email → domain ──────
  const business = await findBusiness(msg, senderEmail);
  if (!business) {
    console.log(`  No match for ${senderEmail} (In-Reply-To: ${msg.inReplyTo || 'none'}) — escalating`);
    await escalateUnmatchedEmail(msg, senderEmail);
    return;
  }

  console.log(`  Reply from ${senderEmail} → matched: ${business.name} [via ${business._matchMethod}]`);

  // ── Deduplication: have we already auto-replied to this business recently? ─
  const { count: recentReplies } = await supabase
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', business.id)
    .eq('type', 'auto_reply_sent')
    .gt('created_at', new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString());

  if (recentReplies > 0) {
    console.log(`  Dedup: already replied to ${business.name} in last 12 hours — skipping auto-reply`);
    // Still classify and log the inbound, just don't reply again
    await classifyAndLog(msg, business, senderEmail, { sendReply: false });
    return;
  }

  // ── Cap: if we've sent too many auto-replies, escalate to manual ─────────
  const { count: totalAutoReplies } = await supabase
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', business.id)
    .eq('type', 'auto_reply_sent');

  const capReached = totalAutoReplies >= AUTO_REPLY_CAP;
  if (capReached) {
    console.log(`  Cap reached: ${business.name} has had ${totalAutoReplies} auto-replies — flagging for manual review`);
  }

  await classifyAndLog(msg, business, senderEmail, { sendReply: !capReached, capReached });
}

async function classifyAndLog(msg, business, senderEmail, { sendReply, capReached = false }) {
  // ── Fetch conversation history for context ───────────────────────────────
  const { data: history } = await supabase
    .from('interactions')
    .select('type, direction, content_summary, raw_content, created_at')
    .eq('business_id', business.id)
    .in('type', ['email_sent', 'follow_up_sent', 'auto_reply_sent', 'reply_received'])
    .order('created_at', { ascending: false })
    .limit(6);

  const conversationHistory = (history || []).reverse();

  // ── Classify ─────────────────────────────────────────────────────────────
  const classification = await classifyReply(msg.text || msg.subject || '');
  const { classification: code, sentiment_score, summary } = classification;
  console.log(`  Classification: ${code} (score ${sentiment_score}/5) | ${summary}`);

  const newStatus = STATUS_MAP[code] || 'engaged';
  const followupDays = FOLLOWUP_DAYS[code];
  const followupDueAt = followupDays
    ? new Date(Date.now() + followupDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  // ── Update business record ───────────────────────────────────────────────
  const dbUpdate = {
    pipeline_status: newStatus,
    last_reply_at: new Date().toISOString(),
    reply_count: (business.reply_count || 0) + 1,
    response_sentiment: sentimentLabel(sentiment_score),
    reply_classification: code,
    follow_up_due_at: followupDueAt,
  };
  if (['2D', '2G', '2H'].includes(code)) dbUpdate.do_not_contact = true;
  if (code === '2D') { dbUpdate.website_exists = true; dbUpdate.is_prospect = false; }

  await supabase.from('businesses').update(dbUpdate).eq('id', business.id);

  await logInteraction(
    business.id,
    'reply_received',
    'inbound',
    `[${code}] Reply from ${senderEmail}: ${summary}`,
    msg.text,
    { from: senderEmail, subject: msg.subject, messageId: msg.messageId, inReplyTo: msg.inReplyTo, classification }
  );

  // ── Send auto-reply ──────────────────────────────────────────────────────
  if (capReached) {
    await sendSlackAlert(code, business, senderEmail, summary, null, sentiment_score, { capReached: true });
    return;
  }

  if (!sendReply) return;

  const checkoutUrl = business.site_slug
    ? `${CHECKOUT_BASE_URL}?slug=${business.site_slug}`
    : CHECKOUT_BASE_URL;

  const replyBody = await generateProspectReply({
    classification: code,
    replyText: msg.text || msg.subject,
    business,
    checkoutUrl,
    conversationHistory,
  });

  if (replyBody) {
    const reSubject = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || 'Your website'}`;
    await sendAutoReply({ to: senderEmail, subject: reSubject, body: replyBody, inReplyTo: msg.messageId });
    console.log(`  ✓ Auto-reply sent [${code}] to ${senderEmail}`);

    await logInteraction(
      business.id,
      'auto_reply_sent',
      'outbound',
      `[${code}] Auto-reply sent to ${senderEmail}`,
      replyBody,
      { to: senderEmail, code, checkoutUrl: ['2A','2B','2C','2I','2J'].includes(code) ? checkoutUrl : null }
    );
  } else if (code === '2H') {
    console.log(`  ⚠ [2H] Hostile — no auto-reply. Flagging for manual review.`);
  }

  await sendSlackAlert(code, business, senderEmail, summary, checkoutUrl, sentiment_score, { capReached: false });
}

// ── Business matching cascade ─────────────────────────────────────────────
async function findBusiness(msg, senderEmail) {
  const activeStatuses = ['emailed', 'follow_up_sent', 'payment_pending', 'engaged', 'nurturing'];

  // 1. In-Reply-To header match — most reliable, works with personal email replies
  if (msg.inReplyTo) {
    const msgId = msg.inReplyTo.replace(/[<>]/g, '').trim();
    const { data } = await supabase
      .from('businesses')
      .select('*, reply_count')
      .eq('outreach_message_id', msgId)
      .in('pipeline_status', activeStatuses)
      .limit(1);
    if (data?.[0]) return { ...data[0], _matchMethod: 'In-Reply-To' };

    // Also check References header (some clients use this instead)
    if (msg.references) {
      for (const ref of (msg.references || '').split(/\s+/)) {
        const refId = ref.replace(/[<>]/g, '').trim();
        const { data: rd } = await supabase
          .from('businesses')
          .select('*, reply_count')
          .eq('outreach_message_id', refId)
          .in('pipeline_status', activeStatuses)
          .limit(1);
        if (rd?.[0]) return { ...rd[0], _matchMethod: 'References' };
      }
    }
  }

  // 2. Sender email match — catches forwarded addresses, catches same-domain replies
  if (senderEmail) {
    const { data } = await supabase
      .from('businesses')
      .select('*, reply_count')
      .ilike('email', senderEmail)
      .in('pipeline_status', activeStatuses)
      .limit(1);
    if (data?.[0]) return { ...data[0], _matchMethod: 'sender email' };
  }

  // 3. Domain match — catches normal business email replies when email field doesn't match exactly
  const senderDomain = senderEmail?.split('@')[1]?.toLowerCase();
  if (senderDomain && !PERSONAL_DOMAINS.has(senderDomain)) {
    const { data } = await supabase
      .from('businesses')
      .select('*, reply_count')
      .ilike('domain', `%${senderDomain}%`)
      .in('pipeline_status', activeStatuses)
      .limit(1);
    if (data?.[0]) return { ...data[0], _matchMethod: 'domain' };
  }

  return null;
}

// ── System / automated sender detection ──────────────────────────────────────
// Emails from these domains are automated reports — mark read and skip, never escalate.
const SYSTEM_SENDER_DOMAINS = new Set([
  'google.com', 'googlemail.com',          // DMARC aggregate reports
  'microsoft.com',                         // DMARC aggregate reports
  'fastmaildmarc.com',                     // DMARC aggregate reports
  'secureserver.net',                      // GoDaddy DMARC reports
  'dmarcanalyzer.com',                     // DMARC SaaS reports
  'stripe.com',                            // Payment processor notifications
  'porkbun.com',                           // Domain registrar notifications
  'zoho.com', 'zohomail.com',              // Our own mail provider
  'resend.com',                            // Email delivery receipts
  'amazonses.com',                         // SES delivery notifications
  'mailer-daemon.googlemail.com',          // Bounce notifications
]);

const SYSTEM_SUBJECT_PATTERNS = [
  /^Report\s+[Dd]omain:/i,                // DMARC report subject lines
  /DMARC\s+(Aggregate|Report)/i,
  /^(Automatic\s+)?[Aa]uto-?[Rr]eply/,
  /^Out\s+of\s+(Office|the\s+Office)/i,
  /^(Undeliverable|Delivery\s+(Status|Failed|Failure))/i,
  /^Mailer-Daemon/i,
  /noreply-dmarc-support@/i,
];

function isSystemSender(msg, senderEmail) {
  const domain = (senderEmail || '').split('@')[1]?.toLowerCase() || '';
  if (SYSTEM_SENDER_DOMAINS.has(domain)) return true;
  const subject = msg.subject || '';
  const from = msg.from || '';
  return SYSTEM_SUBJECT_PATTERNS.some(p => p.test(subject) || p.test(from));
}

// ── Unmatched real email escalation ──────────────────────────────────────────
async function escalateUnmatchedEmail(msg, senderEmail) {
  const { alert } = await import('../lib/slack.js');
  const snippet = (msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  await alert(
    `📬 Unmatched email — review needed`,
    `*From:* ${senderEmail}\n*Subject:* ${msg.subject || '(no subject)'}\n\n${snippet || '(no body)'}\n\n_No matching prospect found. May be a reply from a different address — check manually._`,
  ).catch(() => {});
}

// Well-known personal email domains — skip domain matching for these
const PERSONAL_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','hotmail.com','hotmail.co.uk',
  'outlook.com','outlook.co.uk','live.com','live.co.uk','msn.com','icloud.com','me.com',
  'mac.com','aol.com','protonmail.com','proton.me','zoho.com','btinternet.com','sky.com',
  'btopenworld.com','virginmedia.com','talktalk.net','ntlworld.com','tiscali.co.uk',
]);

// ── Slack notifications ───────────────────────────────────────────────────
async function sendSlackAlert(code, business, email, summary, checkoutUrl, score, { capReached }) {
  const { alert, positiveReply, negativeReply } = await import('../lib/slack.js');
  const info = `${business.name} (${business.category}, ${business.location})`;

  if (capReached) {
    await alert(
      `🙋 Manual reply needed — ${business.name}`,
      `${info}\nFrom: ${email}\n"${summary}"\n\n_Auto-reply limit reached (${AUTO_REPLY_CAP} replies sent). This conversation needs a human._`
    ).catch(() => {});
    return;
  }

  if (code === '2A') {
    await positiveReply({ name: business.name, category: business.category, location: business.location, email, summary, previewUrl: business.preview_url, checkoutUrl }).catch(() => {});
  } else if (code === '2H') {
    await alert(`🚨 Manual review — hostile reply`, `*${info}*\nFrom: ${email}\n"${summary}"\n\n_Do NOT auto-reply. Respond manually._`).catch(() => {});
  } else if (['2G','2D'].includes(code)) {
    await negativeReply({ name: business.name, category: business.category, location: business.location, email, summary, dropReason: code === '2D' ? 'already_has_site' : 'unsubscribed' }).catch(() => {});
  } else if (['2B','2C','2I','2J'].includes(code)) {
    await alert(`💬 Engaged [${code}] — ${business.name}`, `${info}\nFrom: ${email}\n"${summary}"\nAuto-reply sent.`).catch(() => {});
  } else if (['2E','2F'].includes(code)) {
    await alert(`🌱 ${code === '2F' ? 'Price push' : 'Noncommittal'} [${code}] — ${business.name}`, `${info}\nFrom: ${email}\n"${summary}"`).catch(() => {});
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function sentimentLabel(score) {
  return score >= 4 ? 'positive' : score <= 2 ? 'negative' : 'neutral';
}

function extractEmail(fromStr) {
  const m = (fromStr || '').match(/[\w.+'-]+@[\w.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

// ── IMAP ─────────────────────────────────────────────────────────────────
function imapConfig() {
  return { user: IMAP_USER, password: IMAP_PASS, host: IMAP_HOST, port: IMAP_PORT, tls: true, tlsOptions: { rejectUnauthorized: false } };
}

// Two-stage IMAP fetch to avoid parsing large DMARC/XML bodies:
// Stage 1 — headers only for all UNSEEN messages (fast, identifies system senders).
// Stage 2 — full body only for non-system messages (prospect candidates).
// seqno (from imap.search) is stored on every message for reliable mark-seen.
function fetchUnseenReplies() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const imap = new Imap({ ...imapConfig(), connTimeout: 15000, authTimeout: 10000 });
    imap.once('error', fail);
    imap.once('end', () => done([])); // safety net if connection closes before we resolve

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) { imap.end(); return fail(err); }

        imap.search(['UNSEEN'], (err, seqnos) => {
          if (err || !seqnos.length) { imap.end(); return done([]); }

          // Stage 1: headers only
          const headerMap = {};
          const pending1 = [];
          const hf = imap.fetch(seqnos, {
            bodies: 'HEADER.FIELDS (FROM SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES)',
            markSeen: false,
          });

          hf.on('message', (msg, seqno) => {
            let buf = '';
            msg.on('body', (stream) => {
              stream.on('data', c => { buf += c.toString('utf8'); });
              stream.once('end', () => {
                const p = simpleParser(buf).then(parsed => {
                  headerMap[seqno] = {
                    seqno,
                    from: parsed.from?.text || '',
                    subject: parsed.subject || '',
                    messageId: parsed.messageId || null,
                    inReplyTo: parsed.inReplyTo || null,
                    references: parsed.references || null,
                  };
                }).catch(() => { headerMap[seqno] = { seqno, from: '', subject: '' }; });
                pending1.push(p);
              });
            });
          });

          hf.once('end', () => Promise.all(pending1).then(() => {
            const allHeaders = Object.values(headerMap);
            const systemMsgs = allHeaders.filter(h => isSystemSender(h, extractEmail(h.from)));
            const prospectHdrs = allHeaders.filter(h => !isSystemSender(h, extractEmail(h.from)));

            if (systemMsgs.length) {
              console.log(`  ${systemMsgs.length} system email(s) found — will mark read`);
            }

            if (!prospectHdrs.length) {
              // Only system mail — wait for connection to close before resolving
              // so markSeqnosSeen doesn't race with a closing connection
              const result = systemMsgs.map(h => ({ ...h, text: '', _system: true }));
              imap.once('end', () => done(result));
              imap.end();
              return;
            }

            // Stage 2: full body for prospect candidates only
            const messages = systemMsgs.map(h => ({ ...h, text: '', _system: true }));
            const prospectSeqnos = prospectHdrs.map(h => h.seqno);
            const pending2 = [];

            const bf = imap.fetch(prospectSeqnos, { bodies: 'TEXT', markSeen: false });
            bf.on('message', (msg, seqno) => {
              let buf = '';
              msg.on('body', (stream) => {
                stream.on('data', c => { buf += c.toString('utf8'); });
                stream.once('end', () => {
                  const p = simpleParser(buf)
                    .then(parsed => { messages.push({ ...headerMap[seqno], text: parsed.text || '' }); })
                    .catch(() => { messages.push({ ...headerMap[seqno], text: '' }); });
                  pending2.push(p);
                });
              });
            });
            bf.once('end', () => Promise.all(pending2).then(() => {
              imap.once('end', () => done(messages));
              imap.end();
            }));
          }));
        });
      });
    });

    imap.connect();
  });
}

// Mark messages as \Seen using sequence numbers (from imap.search).
// Sequence numbers are stable within a session — using them in a fresh session
// is safe as long as no messages were expunged between the two connections.
function markSeqnosSeen(seqnos) {
  return new Promise((resolve) => {
    if (!seqnos.length) return resolve();
    const imap = new Imap(imapConfig());
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) { imap.end(); return resolve(); }
        imap.addFlags(seqnos, ['\\Seen'], (err) => {
          if (err) console.error('  Mark-seen error:', err.message);
          imap.end();
        });
      });
    });
    imap.once('end', resolve);
    imap.once('error', (err) => { console.error('  Mark-seen IMAP error:', err.message); resolve(); });
    imap.connect();
  });
}
