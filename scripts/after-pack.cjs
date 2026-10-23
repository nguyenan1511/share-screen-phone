// electron-builder afterPack hook:
//  1. drop Chromium's translations except English (~40 MB unpacked: 55 languages Tether's UI never shows)
//  2. ad-hoc sign the finished app. Without any signature, Apple silicon Macs report an unsigned app as "damaged"
//     and refuse to open it. Ad-hoc signing is not Apple's notarized signing: users still confirm once in
//     Privacy & Security.
const { execFileSync } = require('node:child_process');
const { readdirSync, rmSync } = require('node:fs');
const path = require('node:path');

const KEEP_LANGUAGES = new Set(['en.lproj', 'Base.lproj']);

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources');
  for (const name of readdirSync(resources)) {
    if (name.endsWith('.lproj') && !KEEP_LANGUAGES.has(name)) rmSync(path.join(resources, name), { recursive: true, force: true });
  }
  // Universal builds pack each architecture into a "-temp" folder first; sign only the merged app.
  if (context.appOutDir.endsWith('-temp')) return;
  // Developer ID release (scripts/release-mac.mjs found a certificate): electron-builder signs it properly next.
  if (process.env.TETHER_SIGN_IDENTITY) return;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${app}`);
};
