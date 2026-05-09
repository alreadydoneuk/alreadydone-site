# SES DNS Records — alreadydone.uk

Generated: 2026-05-04. Add all of these in Cloudflare once nameservers have propagated.

## DKIM (3 CNAME records — all required)

| Type | Name | Value |
|------|------|-------|
| CNAME | `qqbnggukqyqdlonis6r5fabkmagz7qvk._domainkey.alreadydone.uk` | `qqbnggukqyqdlonis6r5fabkmagz7qvk.dkim.amazonses.com` |
| CNAME | `lcltnkadubr77s4pz6sr66nqg3qyntea._domainkey.alreadydone.uk` | `lcltnkadubr77s4pz6sr66nqg3qyntea.dkim.amazonses.com` |
| CNAME | `vyvk6udjzyl24flc2ruk5ixlqsabdkzw._domainkey.alreadydone.uk` | `vyvk6udjzyl24flc2ruk5ixlqsabdkzw.dkim.amazonses.com` |

## SPF (TXT on root domain)

| Type | Name | Value |
|------|------|-------|
| TXT | `@` (root / alreadydone.uk) | `v=spf1 include:amazonses.com ~all` |

> If an SPF record already exists, add `include:amazonses.com` to it rather than creating a second TXT record.

## DMARC (TXT)

| Type | Name | Value |
|------|------|-------|
| TXT | `_dmarc.alreadydone.uk` | `v=DMARC1; p=none; rua=mailto:dean@alreadydone.uk` |

## After adding records

Check verification status:
```bash
/home/brantley/.local/bin/aws sesv2 get-email-identity --email-identity alreadydone.uk --region eu-west-1 \
  --query 'DkimAttributes.Status'
```

Should return `"SUCCESS"` once verified (usually 5–30 mins after DNS propagates). Then:
1. Run `bash scripts/ses-setup.sh` to generate SMTP credentials
2. Add `SMTP_USER` and `SMTP_PASS` to `.env`
3. Run `node scripts/test-ses.js drougvie@gmail.com` to confirm sending works
4. Request sandbox exit: AWS Console → SES → Account dashboard → Request production access
