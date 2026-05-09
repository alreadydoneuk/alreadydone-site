#!/usr/bin/env bash
# Amazon SES setup script for alreadydone.uk
# Run this once you have AWS credentials configured.
# Usage: bash scripts/ses-setup.sh

set -euo pipefail

AWS="/home/brantley/.local/bin/aws"
DOMAIN="alreadydone.uk"
FROM_EMAIL="dean@alreadydone.uk"
REGION="eu-west-1"

echo ""
echo "=== Already Done — Amazon SES Setup ==="
echo "Domain:  $DOMAIN"
echo "Region:  $REGION"
echo ""

# ── 1. Verify AWS credentials ────────────────────────────────────────────────
echo "Checking AWS credentials..."
IDENTITY=$($AWS sts get-caller-identity --region "$REGION" --output text --query 'Account' 2>/dev/null || echo "")
if [[ -z "$IDENTITY" ]]; then
  echo ""
  echo "ERROR: No AWS credentials found."
  echo "Run: aws configure"
  echo "  AWS Access Key ID:     (from IAM console)"
  echo "  AWS Secret Access Key: (from IAM console)"
  echo "  Default region name:   eu-west-1"
  echo "  Default output format: json"
  echo ""
  exit 1
fi
echo "  ✓ Authenticated as account: $IDENTITY"
echo ""

# ── 2. Register domain identity with SES ─────────────────────────────────────
echo "Registering $DOMAIN with SES..."
$AWS sesv2 create-email-identity \
  --email-identity "$DOMAIN" \
  --dkim-signing-attributes SigningAttributesOrigin=AWS_SES \
  --region "$REGION" \
  --output json > /tmp/ses-identity.json 2>/dev/null || true

# Re-fetch current state (covers case where identity already exists)
$AWS sesv2 get-email-identity \
  --email-identity "$DOMAIN" \
  --region "$REGION" \
  --output json > /tmp/ses-identity.json

echo "  ✓ Domain registered"
echo ""

# ── 3. Print DNS records to add ──────────────────────────────────────────────
echo "================================================================"
echo "DNS RECORDS — add all of these to your domain registrar / DNS"
echo "================================================================"
echo ""

# Domain verification TXT
VERIFICATION_TOKEN=$(python3 -c "
import json
data = json.load(open('/tmp/ses-identity.json'))
token = data.get('DkimAttributes', {}).get('Tokens', [])
print('(see DKIM records below — no separate TXT needed for DKIM Easy DKIM)')
" 2>/dev/null || echo "")

# DKIM CNAME records
echo "── DKIM (3 records, all required) ─────────────────────────────"
python3 -c "
import json
data = json.load(open('/tmp/ses-identity.json'))
tokens = data.get('DkimAttributes', {}).get('Tokens', [])
domain = 'alreadydone.uk'
for t in tokens:
    print(f'  Type:  CNAME')
    print(f'  Name:  {t}._domainkey.{domain}')
    print(f'  Value: {t}.dkim.amazonses.com')
    print()
"

# SPF record
echo "── SPF (add to existing TXT on root domain, or create new) ────"
echo "  Type:  TXT"
echo "  Name:  alreadydone.uk  (root / @)"
echo "  Value: \"v=spf1 include:amazonses.com ~all\""
echo "  Note:  If you already have an SPF record, add 'include:amazonses.com'"
echo "         to the existing one rather than creating a second TXT record."
echo ""

# DMARC record
echo "── DMARC (recommended — improves deliverability) ───────────────"
echo "  Type:  TXT"
echo "  Name:  _dmarc.alreadydone.uk"
echo "  Value: \"v=DMARC1; p=none; rua=mailto:rougvie@alreadydone.uk\""
echo ""

echo "================================================================"
echo ""

# ── 4. Check current verification status ─────────────────────────────────────
DKIM_STATUS=$(python3 -c "
import json
data = json.load(open('/tmp/ses-identity.json'))
print(data.get('DkimAttributes', {}).get('Status', 'PENDING'))
")
VERIFIED=$(python3 -c "
import json
data = json.load(open('/tmp/ses-identity.json'))
print(data.get('VerifiedForSendingStatus', False))
")

echo "Current status:"
echo "  DKIM:     $DKIM_STATUS"
echo "  Verified: $VERIFIED"
echo ""

if [[ "$DKIM_STATUS" != "SUCCESS" ]]; then
  echo "  → DNS records not yet verified. Add the records above then"
  echo "    re-run this script to check status. Usually takes 5–30 minutes."
  echo ""
fi

# ── 5. Create SMTP credentials ───────────────────────────────────────────────
echo "Creating SMTP credentials..."
SMTP_CREDS=$($AWS iam create-user --user-name alreadydone-ses-smtp --output json 2>/dev/null || echo "exists")

if echo "$SMTP_CREDS" | grep -q 'exists'; then
  echo "  (IAM user alreadydone-ses-smtp already exists)"
else
  $AWS iam attach-user-policy \
    --user-name alreadydone-ses-smtp \
    --policy-arn arn:aws:iam::aws:policy/AmazonSESFullAccess 2>/dev/null || true
fi

ACCESS_KEY=$($AWS iam create-access-key --user-name alreadydone-ses-smtp --output json 2>/dev/null || echo "")
if [[ -n "$ACCESS_KEY" ]] && echo "$ACCESS_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['AccessKey']['AccessKeyId'])" 2>/dev/null; then
  KEY_ID=$(echo "$ACCESS_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['AccessKey']['AccessKeyId'])")
  KEY_SECRET=$(echo "$ACCESS_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['AccessKey']['SecretAccessKey'])")

  # Convert IAM credentials to SES SMTP password
  # SES SMTP password is derived from the secret key via HMAC-SHA256
  SMTP_PASS=$(python3 -c "
import hmac, hashlib, base64
date = '11111111'
service = 'ses'
region = 'eu-west-1'
terminal = 'aws4_request'
secret = '${KEY_SECRET}'
message = 'SendRawEmail'
k_date    = hmac.new(('AWS4' + secret).encode(), date.encode(), hashlib.sha256).digest()
k_region  = hmac.new(k_date, region.encode(), hashlib.sha256).digest()
k_service = hmac.new(k_region, service.encode(), hashlib.sha256).digest()
k_terminal= hmac.new(k_service, terminal.encode(), hashlib.sha256).digest()
k_message = hmac.new(k_terminal, message.encode(), hashlib.sha256).digest()
print(base64.b64encode(bytes([0x04]) + k_message).decode())
" 2>/dev/null || echo "")

  echo ""
  echo "================================================================"
  echo "SMTP CREDENTIALS — add these to .env"
  echo "================================================================"
  echo "  SMTP_USER=$KEY_ID"
  if [[ -n "$SMTP_PASS" ]]; then
    echo "  SMTP_PASS=$SMTP_PASS"
  else
    echo "  SMTP_PASS=(see SES console → SMTP Settings → Create SMTP credentials)"
  fi
  echo "================================================================"
  echo ""
fi

# ── 6. Sandbox exit reminder ─────────────────────────────────────────────────
echo "================================================================"
echo "SANDBOX EXIT — you must request this manually"
echo "================================================================"
echo ""
echo "SES starts in sandbox mode: can only send to verified addresses."
echo "To send to real prospects you need production access."
echo ""
echo "Request it here (takes 24–48h, almost always approved):"
echo "  AWS Console → SES → Account dashboard → Request production access"
echo ""
echo "Use this text in the request:"
echo "  Use case: B2B cold outreach to small business owners in the UK."
echo "  We send personalised emails to businesses identified as lacking a"
echo "  functional website. Volume: ~100 emails/day initially, growing to"
echo "  ~500/day. We honour unsubscribes immediately and maintain a"
echo "  suppression list. Bounce and complaint handling is implemented."
echo "================================================================"
echo ""
echo "Done. Re-run this script after adding DNS records to check status."
