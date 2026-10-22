# Releasing Tether for Mac

Releases go to Amazon S3 (`tether-releases-eland`, Singapore). Installed apps check
`mac/latest.json` and update themselves (see `desktop/updater.js`); the website's
**Download for Mac** button always serves `mac/Tether.dmg`.

## One-time setup
`.env.release` in the project folder (git-ignored, only you can read it):

```
AWS_REGION=ap-southeast-1
TETHER_S3_BUCKET=tether-releases-eland
AWS_ACCESS_KEY_ID=…        # IAM user tether-release-uploader (can only upload to mac/)
AWS_SECRET_ACCESS_KEY=…
```

## Every release
1. Commit your changes.
2. Bump the version and commit it:
   `npm version patch --no-git-tag-version` → commit `package.json` + `package-lock.json`.
3. `npm run release:mac`
   (optional notes: `TETHER_RELEASE_NOTES="Faster cursor" npm run release:mac`)

The script refuses to run with uncommitted changes or a version that's already on S3,
builds the universal app, uploads the zip + dmg, and publishes `latest.json` last.
Within ~4 hours every running Tether finds it, downloads it in the background and
installs it the next time it isn't sharing.

`npm run release:mac -- --dry-run` builds and writes `dist/release/` without uploading.

## Notes
- Until Tether is signed with an Apple Developer ID, macOS resets Screen Recording after
  each update; the app explains how to turn it back on.
- With a Developer ID: sign + notarize, then switch `desktop/updater.js` to
  electron-updater (the release already uploads `latest-mac.yml` for it).
