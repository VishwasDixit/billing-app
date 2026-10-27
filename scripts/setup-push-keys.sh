#!/usr/bin/env bash
# Creates the Web Push (VAPID) key pair and adds it to Vercel Production. The private key is
# piped straight into Vercel and never printed or saved. Run once; then redeploy.
set -euo pipefail
cd "$(dirname "$0")/.."
VERCEL="npx --yes vercel@65.2.0"
echo "Checking Vercel…"
if $VERCEL env ls production | grep -q "VAPID_PRIVATE_KEY"; then
  echo "VAPID keys are already set in Vercel. Nothing to do."
  exit 0
fi
keys="$(node -e 'const w=require("web-push");const k=w.generateVAPIDKeys();process.stdout.write(k.publicKey+" "+k.privateKey)')"
pub="${keys%% *}"
priv="${keys##* }"
echo "Adding the keys…"
printf '%s' "$pub" | $VERCEL env add VAPID_PUBLIC_KEY production
printf '%s' "$priv" | $VERCEL env add VAPID_PRIVATE_KEY production
unset keys priv
echo "Added VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to Vercel (Production)."
echo "Public key (safe to share): $pub"
