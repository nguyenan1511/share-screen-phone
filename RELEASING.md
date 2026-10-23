# Releasing Tether for Mac

Releases go to Amazon S3 (`tether-releases-eland`, Singapore). Installed apps check
`mac/latest.json` and update themselves (see `desktop/updater.js`); the website's
**Download for Mac** button serves `mac/Tether.dmg` (Apple silicon) or `mac/Tether-Intel.dmg`.

## One-time setup
`.env.release` in the project folder (git-ignored, only you can read it):

```
AWS_REGION=ap-southeast-1
TETHER_S3_BUCKET=tether-releases-eland
AWS_ACCESS_KEY_ID=…        # IAM user tether-release-uploader (can only upload/delete in mac/)
AWS_SECRET_ACCESS_KEY=…
```

The IAM user's policy allows only these two actions, only under `mac/`:
```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::tether-releases-eland/mac/*" }] }
```

### Apple signing (Developer ID)
With a **Developer ID Application** certificate in the login keychain, `release:mac` signs the
app with it (hardened runtime, `assets/entitlements.mac.plist`), has Apple notarize the app
and the dmg, staples both and checks them with Gatekeeper. No warning when users open it, and
macOS keeps Screen Recording permission across updates. One-time:
1. developer.apple.com → Certificates → **+** → *Developer ID Application* (G2 Sub-CA) → upload
   a certificate signing request → download the `.cer` and add it to the login keychain
   together with its private key.
2. appleid.apple.com → Sign-In and Security → **App-Specific Passwords** → make one for Tether.
3. `xcrun notarytool store-credentials tether-notary` (asks for Apple ID, Team ID, that password;
   it is stored in the keychain, never in a file).

No certificate on the Mac → the release is ad-hoc signed, as before.

## Every release
1. Commit your changes.
2. Bump the version and commit it:
   `npm version patch --no-git-tag-version` → commit `package.json` + `package-lock.json`.
3. `npm run release:mac`
   (optional notes: `TETHER_RELEASE_NOTES="Faster cursor" npm run release:mac`)

The script refuses to run with uncommitted changes or a version that's already on S3,
builds an Apple silicon and an Intel app, uploads their update packages + dmgs, publishes `latest.json` last, then
deletes the previous version's files (`mac/<old version>/`), so S3 only holds the newest.
Within ~4 hours every running Tether finds it, downloads it in the background and
installs it the next time it isn't sharing.

`npm run release:mac -- --dry-run` builds and writes `dist/release/` without uploading.
`npm run release:mac -- --remove 0.1.3,0.1.4` only deletes those old versions (never the current one).

## Notes
- Ad-hoc builds: macOS resets Screen Recording after each update; the app offers **Fix it**.
  The first Developer ID update needs it one last time; after that the permission stays.
- Once Tether is Developer ID signed, the updater only accepts updates from the same Apple team.
- Sizes: one app per chip (a universal app carries Electron twice), only English Chromium strings
  (`scripts/after-pack.cjs`), updates as `.tar.xz`, dmgs as LZMA (ULMO). Update ≈ 60 MB, installer ≈ 70 MB,
  instead of 174 / 180 MB for 0.1.8.
- `latest.json` still carries `zip` (a universal app merged from the two builds) for installed 0.1.8 and older,
  which only read that field. Drop it from `scripts/release-mac.mjs` once nobody runs those versions.
