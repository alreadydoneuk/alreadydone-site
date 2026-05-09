#!/usr/bin/env bash
# Deploy alreadydone.uk — pushes to GitHub and deploys to Cloudflare Pages
# Usage: bash scripts/deploy-site.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SITE_DIR="$ROOT_DIR/sites/alreadydone.uk"
cd "$SITE_DIR"

# Push to GitHub
echo "Pushing to GitHub..."
git add -A
if git diff --cached --quiet; then
  echo "  No changes to commit"
else
  git commit -m "Update site — $(date '+%Y-%m-%d %H:%M')"
fi
git push origin main
echo "  ✓ GitHub up to date"

# Deploy to Cloudflare Pages
echo ""
echo "Deploying to Cloudflare Pages..."
source "$ROOT_DIR/.env"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_TOKEN" \
CLOUDFLARE_ACCOUNT_ID="c663467f92484cce5de42806e1a1e868" \
npx wrangler pages deploy . --project-name=alreadydone-uk 2>&1

echo ""
echo "Live at: https://alreadydone.uk"
