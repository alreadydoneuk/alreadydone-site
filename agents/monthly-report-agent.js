import { supabase, logInteraction } from '../lib/db.js';
import { sendCustomerReport } from '../lib/mailer.js';
import { alert } from '../lib/slack.js';
import 'dotenv/config';

export async function runMonthlyReportAgent() {
  // Find delivered customers whose last report was >28 days ago (or never sent)
  const threshold = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

  const { data: customers, error } = await supabase
    .from('businesses')
    .select('id, name, category, location, customer_email, email, customer_first_name, registered_domain, delivered_at, last_report_sent_at')
    .eq('pipeline_status', 'delivered')
    .not('registered_domain', 'is', null)
    .or(`last_report_sent_at.is.null,last_report_sent_at.lt.${threshold}`);

  if (error) throw error;
  if (!customers?.length) {
    console.log('Monthly report: no customers due a report');
    return { sent: 0 };
  }

  console.log(`Monthly report: sending to ${customers.length} customer(s)`);
  let sent = 0;

  for (const c of customers) {
    try {
      const to = c.customer_email || c.email;
      if (!to) { console.log(`  Skipping ${c.name} — no email`); continue; }

      const deliveredAt = c.delivered_at ? new Date(c.delivered_at) : null;
      const renewalDate = deliveredAt
        ? new Date(deliveredAt.getFullYear() + 1, deliveredAt.getMonth(), deliveredAt.getDate())
        : null;

      const monthsLive = deliveredAt
        ? Math.floor((Date.now() - deliveredAt.getTime()) / (1000 * 60 * 60 * 24 * 30))
        : null;

      await sendCustomerReport({
        to,
        firstName: c.customer_first_name || null,
        domain: c.registered_domain,
        monthsLive,
        renewalDate,
      });

      await supabase
        .from('businesses')
        .update({ last_report_sent_at: new Date().toISOString() })
        .eq('id', c.id);

      await logInteraction(
        c.id,
        'monthly_report',
        'outbound',
        `Monthly check-in sent to ${to}`,
        null,
        { to, domain: c.registered_domain }
      );

      console.log(`  ✓ ${c.name} → ${to}`);
      sent++;
    } catch (err) {
      console.error(`  Failed for ${c.name}: ${err.message}`);
    }
  }

  if (sent > 0) {
    await alert(`📊 Monthly reports sent to ${sent} customer${sent !== 1 ? 's' : ''}`, '').catch(() => {});
  }

  return { sent };
}
