// electron-builder afterPack hook: ad-hoc sign the finished universal app.
// Without any signature, Apple silicon Macs report an unsigned app as "damaged" and refuse to open it.
// Ad-hoc signing is not Apple's notarized signing: users still confirm once in Privacy & Security.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // Universal builds pack each architecture into a "-temp" folder first; sign only the merged app.
  if (context.appOutDir.endsWith('-temp')) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${app}`);
};
