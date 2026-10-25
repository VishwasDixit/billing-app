# Android app (Trusted Web Activity)

A ~1 MB Android shell that opens https://billing-app-chi-five.vercel.app full screen in Chrome.
The app *is* the website: anything pushed to `main` shows up in the app straight away, with no
Play update needed. Generated with Google's Bubblewrap; `twa-manifest.json` holds its settings.

## Build
```
npm run android:build
```
- **Output:** `android/out/billing.apk` (install on a phone) and `android/out/billing.aab` (upload to Play).
- **Toolchain:** Java 17 and the Android SDK, in `~/.bubblewrap/`.
- **Signing:** the upload key is `~/billing-keys/upload.keystore`, kept outside the repo. Back it up together with its password.
  - If it's lost, Play Console can reset the upload key (Setup › App signing), but that takes a few days.

## Releasing an update to the Android shell
Only needed when the shell itself changes (name, icon, colours, host). Website changes never need it.
1. Raise `appVersionCode` (+1) and `appVersionName` in `twa-manifest.json`.
2. In `app/build.gradle`, raise `versionCode` and `versionName` to match.
3. Run `npm run android:build`, then upload `out/billing.aab` to Play Console.

## No address bar = Digital Asset Links
- `public/.well-known/assetlinks.json` (served by the website) must list the SHA-256 fingerprint of every key that signs the installed app:
  - the **upload key**: `build.sh` prints it;
  - the **Play App Signing key**: in Play Console › Setup › App signing.
- Missing a fingerprint means the app still works, but shows a small browser bar at the top.
- To check:
  `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://billing-app-chi-five.vercel.app&relation=delegate_permission/common.handle_all_urls`

## Moving to your own domain
Change `host` in `twa-manifest.json` and `hostName` in `app/build.gradle`. Put `assetlinks.json` on the new domain, then release an update (steps above).
