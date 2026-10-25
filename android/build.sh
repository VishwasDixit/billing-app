#!/usr/bin/env bash
# Builds the Android app (Play Store bundle + an APK to install directly), signed with the upload key.
# The key lives outside the repo in ~/billing-keys; the password is asked for with hidden input
# (or read from BILLING_KEY_PASSWORD) and never written anywhere.
set -euo pipefail
cd "$(dirname "$0")"

export JAVA_HOME="${JAVA_HOME:-$(ls -d "$HOME"/.bubblewrap/jdk/*/Contents/Home 2>/dev/null | head -1)}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.bubblewrap/android_sdk}"
BT="$ANDROID_HOME/build-tools/35.0.0"
KEYSTORE="$HOME/billing-keys/upload.keystore"
ALIAS=upload

if [ -z "${BILLING_KEY_PASSWORD:-}" ]; then
  if [ -f "$KEYSTORE" ]; then
    read -r -s -p "Signing key password: " BILLING_KEY_PASSWORD; echo
  else
    echo "No signing key yet. Choose a password for it (at least 6 characters)."
    echo "Keep it safe with the key file: you need both for every app update."
    read -r -s -p "New key password: " BILLING_KEY_PASSWORD; echo
    read -r -s -p "Type it again: " again; echo
    [ "$BILLING_KEY_PASSWORD" = "$again" ] || { echo "The passwords don't match."; exit 1; }
    [ ${#BILLING_KEY_PASSWORD} -ge 6 ] || { echo "Use at least 6 characters."; exit 1; }
  fi
fi
export BILLING_KEY_PASSWORD

if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")" && chmod 700 "$(dirname "$KEYSTORE")"
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KEYSTORE" -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Billing Shop POS" -storepass:env BILLING_KEY_PASSWORD -keypass:env BILLING_KEY_PASSWORD -noprompt
  chmod 600 "$KEYSTORE"
  echo "Created the signing key: $KEYSTORE  (back this file up!)"
fi

./gradlew --quiet assembleRelease bundleRelease

mkdir -p out
"$BT/zipalign" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk out/aligned.apk
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-key-alias "$ALIAS" --ks-pass env:BILLING_KEY_PASSWORD --key-pass env:BILLING_KEY_PASSWORD \
  --out out/billing.apk out/aligned.apk
rm -f out/aligned.apk out/billing.apk.idsig
cp app/build/outputs/bundle/release/app-release.aab out/billing.aab
"$JAVA_HOME/bin/jarsigner" -keystore "$KEYSTORE" -storepass:env BILLING_KEY_PASSWORD -keypass:env BILLING_KEY_PASSWORD \
  -sigalg SHA256withRSA -digestalg SHA-256 out/billing.aab "$ALIAS" >/dev/null

echo
echo "Built:"
echo "  $(pwd)/out/billing.apk   (install on a phone)"
echo "  $(pwd)/out/billing.aab   (upload to Play Console)"
echo "Upload key SHA-256 (for assetlinks.json):"
"$JAVA_HOME/bin/keytool" -list -keystore "$KEYSTORE" -alias "$ALIAS" -storepass:env BILLING_KEY_PASSWORD | sed -n 's/.*(SHA-256): //p' | grep . || \
  "$JAVA_HOME/bin/keytool" -list -v -keystore "$KEYSTORE" -alias "$ALIAS" -storepass:env BILLING_KEY_PASSWORD | grep 'SHA256:'
