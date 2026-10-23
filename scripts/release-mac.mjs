// Publish a Tether release to S3:  npm run release:mac   (or: npm run release:mac -- --dry-run)
//
// 1. refuses with uncommitted changes, or when this version is already on S3
// 2. builds one app per chip (npm run dist:mac → dist/mac-arm64, dist/mac): half the size of a universal app.
//    Updates ship as xz-compressed tarballs (about a third of the old universal zip); the dmgs are LZMA.
//    Website installers: mac/Tether.dmg (Apple silicon) and mac/Tether-Intel.dmg.
// 3. writes latest.json — what the app's updater reads: `updates.arm64` / `updates.x64` (url, SHA-256, size),
//    plus `zip`, a universal zip merged from the two apps for installed versions 0.1.8 and older, which only know
//    that field (drop it once nobody runs those)
// 4. uploads versioned files first, then the "always newest" dmgs, and latest.json LAST,
//    so users never see a version whose files aren't up yet
// 5. reads latest.json back from the public URL to confirm
// 6. deletes the previous version's files (mac/<old>/…), so S3 only keeps the newest release
//
// Apple signing: when the Mac has a "Developer ID Application" certificate in the keychain, the build is signed
// with it (hardened runtime), the app and the dmg are notarized by Apple and stapled, so users get no Gatekeeper
// warning and macOS keeps Screen Recording permission across updates. Notarization reads the keychain profile
// made once with `xcrun notarytool store-credentials tether-notary` (TETHER_NOTARY_PROFILE to change the name).
// No certificate → ad-hoc signed as before (scripts/after-pack.cjs).
//
// Remove leftover old versions by hand:  npm run release:mac -- --remove 0.1.3,0.1.4   (no build, no upload)
//
// Credentials come only from .env.release (git-ignored, chmod 600): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// AWS_REGION, TETHER_S3_BUCKET. --dry-run builds and writes dist/release/ (latest.json + files) without uploading.
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dryRun = process.argv.includes('--dry-run');
const allowDirty = process.argv.includes('--allow-dirty');
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

// .env.release → process.env (KEY=VALUE lines; values never printed)
const envFile = path.join(root, '.env.release');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const { AWS_REGION: region, TETHER_S3_BUCKET: bucket } = process.env;
if (!dryRun) {
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'TETHER_S3_BUCKET']) {
    if (!process.env[k]) fail(`${k} is missing (put it in .env.release)`);
  }
}
const base = dryRun ? (process.env.TETHER_RELEASE_BASE || 'http://localhost:8099/mac') : `https://${bucket}.s3.${region}.amazonaws.com/mac`;

// Delete one old version's files. Never the version being released (or the "newest" files outside mac/<ver>/).
async function removeVersions(versions) {
  const old = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && v !== version);
  if (!old.length) return;
  const s3 = new S3Client({ region });
  const Objects = old.flatMap((v) => [`Tether-${v}-universal.zip`, `Tether-${v}-arm64.tar.xz`, `Tether-${v}-x64.tar.xz`,
    'Tether.dmg', 'Tether-Intel.dmg'].map((name) => ({ Key: `mac/${v}/${name}` })));
  const res = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects, Quiet: true } }));
  if (res.Errors?.length) fail(`could not delete ${res.Errors.map((e) => `${e.Key} (${e.Code})`).join(', ')}`);
  for (const v of old) {
    const gone = (await fetch(`${base}/${v}/Tether.dmg`, { method: 'HEAD' })).status !== 200;
    console.log(`  ✕ mac/${v}/ … ${gone ? 'removed' : 'still there?'}`);
  }
}

const removeArg = process.argv.find((a, i) => process.argv[i - 1] === '--remove');
if (removeArg) {
  console.log('Removing old versions from S3…');
  await removeVersions(removeArg.split(','));
  process.exit(0);
}

// 1. safety checks
if (!allowDirty && !dryRun) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) fail('commit your changes first (the release must match a commit)');
}
let previous = null; // the version on S3 right now; removed once the new one is live
if (!dryRun) {
  const res = await fetch(`${base}/${version}/Tether.dmg`, { method: 'HEAD' });
  if (res.ok) fail(`${version} is already on S3 — bump the version (npm version patch --no-git-tag-version)`);
  previous = await fetch(`${base}/latest.json`, { headers: { 'Cache-Control': 'no-cache' } })
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.version ?? null).catch(() => null);
}

// 2. build (signed with Developer ID when this Mac has the certificate)
const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout || '';
const identity = identities.match(/"Developer ID Application: ([^"]+)"/)?.[1] ?? null;
const notaryProfile = process.env.TETHER_NOTARY_PROFILE || 'tether-notary';
if (identity) {
  const ok = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', notaryProfile], { encoding: 'utf8' });
  if (ok.status !== 0) fail(`Developer ID found, but no notary login. Run once: xcrun notarytool store-credentials ${notaryProfile}`);
}
console.log(`Building Tether ${version}… (${identity ? `signed by ${identity}, notarized` : 'ad-hoc signed — no Developer ID certificate'})`);
const signArgs = identity ? [`-c.mac.identity=${identity}`, '-c.mac.hardenedRuntime=true',
  '-c.mac.entitlements=assets/entitlements.mac.plist', '-c.mac.entitlementsInherit=assets/entitlements.mac.plist'] : [];
const buildEnv = identity
  ? { ...process.env, TETHER_SIGN_IDENTITY: identity, APPLE_KEYCHAIN_PROFILE: notaryProfile }
  : { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
if (spawnSync('npm', ['run', '-s', 'build:helpers'], { cwd: root, stdio: 'inherit' }).status !== 0) fail('helper build failed');
// One chip at a time, and again if it fails: making a dmg mounts a disk named "Tether", and macOS sometimes still
// holds it for a moment when electron-builder ejects it ("hdiutil detach … exit 16"), which fails the build.
for (const arch of ['arm64', 'x64']) {
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    if (attempt > 1) {
      console.log(`  • ${arch} build failed, trying again (${attempt}/3)…`);
      spawnSync('/usr/bin/hdiutil', ['detach', '-force', '/Volumes/Tether'], { stdio: 'ignore' });
    }
    ok = spawnSync('npx', ['electron-builder', '--mac', `--${arch}`, ...signArgs], { cwd: root, stdio: 'inherit', env: buildEnv }).status === 0;
  }
  if (!ok) fail(`build failed (${arch})`);
}
const dist = path.join(root, 'dist');
const run = (cmd, args, what) => {
  if (spawnSync(cmd, args, { stdio: 'inherit' }).status !== 0) fail(`${what} failed`);
};
// electron-builder puts the Intel app in dist/mac, the Apple silicon one in dist/mac-arm64.
const ARCHES = {
  arm64: { app: path.join(dist, 'mac-arm64', 'Tether.app'), dmg: path.join(dist, 'Tether-arm64.dmg'), site: 'Tether.dmg' },
  x64: { app: path.join(dist, 'mac', 'Tether.app'), dmg: path.join(dist, 'Tether-x64.dmg'), site: 'Tether-Intel.dmg' },
};
for (const a of Object.values(ARCHES)) for (const f of [a.app, a.dmg]) if (!existsSync(f)) fail(`missing ${path.relative(root, f)}`);

// LZMA dmgs (ULMO, macOS 10.15+): about 20% smaller than electron-builder's zlib ones, which it can't make itself.
for (const a of Object.values(ARCHES)) {
  const lzma = a.dmg.replace(/\.dmg$/, '-lzma.dmg');
  rmSync(lzma, { force: true });
  run('/usr/bin/hdiutil', ['convert', a.dmg, '-format', 'ULMO', '-quiet', '-o', lzma], 'compressing the dmg');
  rmSync(a.dmg);
  run('/bin/mv', [lzma, a.dmg], 'compressing the dmg');
}

// Signed builds: the apps inside are already notarized + stapled by electron-builder; sign, notarize and staple
// the dmgs too, then let Gatekeeper judge them the way a user's Mac will.
if (identity) {
  for (const a of Object.values(ARCHES)) {
    console.log(`  • ${path.basename(a.dmg)}: signing, notarizing (a few minutes), stapling, Gatekeeper check`);
    run('codesign', ['--force', '--sign', `Developer ID Application: ${identity}`, '--timestamp', a.dmg], 'signing the dmg');
    run('xcrun', ['notarytool', 'submit', a.dmg, '--keychain-profile', notaryProfile, '--wait'], 'notarizing the dmg');
    run('xcrun', ['stapler', 'staple', a.dmg], 'stapling the dmg');
    run('spctl', ['--assess', '--type', 'execute', '-v', a.app], 'Gatekeeper check: app');
    run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', a.dmg], 'Gatekeeper check: dmg');
  }
}

// Update packages: tar.xz of each app (no AppleDouble files, so the signature stays valid), checked by unpacking
// it the way the updater does and verifying the signature.
const fileInfo = (file, name) => ({ url: `${base}/${version}/${name}`, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), size: statSync(file).size });
const updates = {};
const uploads = []; // [file, name]
for (const [arch, a] of Object.entries(ARCHES)) {
  const name = `Tether-${version}-${arch}.tar.xz`;
  const file = path.join(dist, name);
  console.log(`  • packing ${name}…`);
  run('/usr/bin/tar', ['--no-mac-metadata', '--options', 'xz:compression-level=9', '-cJf', file, '-C', path.dirname(a.app), 'Tether.app'], 'packing');
  const check = mkdtempSync(path.join(os.tmpdir(), 'tether-check-'));
  run('/usr/bin/tar', ['-xJf', file, '-C', check], 'unpacking check');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(check, 'Tether.app')], 'signature check after unpacking');
  rmSync(check, { recursive: true, force: true });
  updates[arch] = { format: 'tar.xz', ...fileInfo(file, name) };
  uploads.push([file, name]);
}

// For installed 0.1.8 and older (they read only `zip` and can't tell the chip): one universal app, merged from the
// two builds (no rebuild), ad-hoc or Developer ID signed like them.
const legacyName = `Tether-${version}-universal.zip`;
const legacyZip = path.join(dist, legacyName);
{
  console.log(`  • merging ${legacyName} for older versions…`);
  const { makeUniversalApp } = createRequire(import.meta.url)('@electron/universal');
  const merged = path.join(dist, 'mac-universal', 'Tether.app');
  rmSync(path.dirname(merged), { recursive: true, force: true });
  mkdirSync(path.dirname(merged), { recursive: true });
  // The merge wants identical non-binary files, so it gets unsigned copies; the result is signed below.
  const work = mkdtempSync(path.join(os.tmpdir(), 'tether-universal-'));
  const unsigned = {};
  for (const [arch, a] of Object.entries(ARCHES)) {
    unsigned[arch] = path.join(work, arch, 'Tether.app');
    mkdirSync(path.dirname(unsigned[arch]));
    run('/usr/bin/ditto', [a.app, unsigned[arch]], 'copying the app');
    run('/usr/bin/find', [unsigned[arch], '-name', '_CodeSignature', '-type', 'd', '-prune', '-exec', 'rm', '-rf', '{}', '+'], 'unsigning the copy');
  }
  await makeUniversalApp({ x64AppPath: unsigned.x64, arm64AppPath: unsigned.arm64, outAppPath: merged, force: true,
    x64ArchFiles: 'Contents/Resources/phone-display' });
  rmSync(work, { recursive: true, force: true });
  const signWith = identity
    ? ['--force', '--deep', '--options', 'runtime', '--timestamp', '--entitlements', path.join(root, 'assets/entitlements.mac.plist'),
       '--sign', `Developer ID Application: ${identity}`, merged]
    : ['--force', '--deep', '--sign', '-', merged];
  run('/usr/bin/codesign', signWith, 'signing the universal app');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', merged], 'verifying the universal app');
  rmSync(legacyZip, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', merged, legacyZip], 'zipping the universal app');
  uploads.push([legacyZip, legacyName]);
}

// 3. latest.json
const latest = {
  version,
  releasedAt: new Date().toISOString(),
  notes: process.env.TETHER_RELEASE_NOTES || '',
  updates,
  zip: fileInfo(legacyZip, legacyName),
  dmg: { url: `${base}/Tether.dmg`, intel: `${base}/Tether-Intel.dmg` },
};
const mb = (n) => `${(n / 1e6).toFixed(0)} MB`;
console.log(`\nSizes: update ${mb(updates.arm64.size)} (Apple silicon) / ${mb(updates.x64.size)} (Intel), ` +
  `installer ${mb(statSync(ARCHES.arm64.dmg).size)} / ${mb(statSync(ARCHES.x64.dmg).size)}`);

if (dryRun) {
  const out = path.join(dist, 'release', 'mac');
  mkdirSync(path.join(out, version), { recursive: true });
  for (const [file, name] of uploads) copyFileSync(file, path.join(out, version, name));
  for (const a of Object.values(ARCHES)) copyFileSync(a.dmg, path.join(out, a.site));
  writeFileSync(path.join(out, 'latest.json'), JSON.stringify(latest, null, 2));
  console.log(`\nDry run: ${path.relative(root, out)}/ has latest.json and the files (feed base ${base}).`);
  process.exit(0);
}

// 4. upload (latest.json last)
const s3 = new S3Client({ region });
const IMMUTABLE = 'public, max-age=31536000, immutable';
const FRESH = 'no-cache';
async function put(key, file, contentType, cacheControl) {
  const body = typeof file === 'string' && existsSync(file) ? createReadStream(file) : file;
  const length = typeof file === 'string' && existsSync(file) ? statSync(file).size : Buffer.byteLength(file);
  process.stdout.write(`  ↑ ${key} … `);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: length, ContentType: contentType, CacheControl: cacheControl }));
  console.log('done');
}
console.log(`\nUploading to s3://${bucket}/mac/ …`);
for (const [file, name] of uploads) await put(`mac/${version}/${name}`, file, name.endsWith('.zip') ? 'application/zip' : 'application/x-xz', IMMUTABLE);
for (const a of Object.values(ARCHES)) await put(`mac/${version}/${a.site}`, a.dmg, 'application/x-apple-diskimage', IMMUTABLE);
for (const a of Object.values(ARCHES)) await put(`mac/${a.site}`, a.dmg, 'application/x-apple-diskimage', FRESH);
await put('mac/latest.json', JSON.stringify(latest, null, 2), 'application/json', FRESH);

// 5. confirm from the public URL
const check = await fetch(`${base}/latest.json`, { headers: { 'Cache-Control': 'no-cache' } }).then((r) => r.json()).catch(() => null);
if (check?.version !== version) fail(`public latest.json says ${check?.version ?? 'nothing'}, expected ${version}`);
console.log(`\n✓ Tether ${version} is live.\n  Download: ${base}/Tether.dmg (Apple silicon), ${base}/Tether-Intel.dmg\n  Feed:     ${base}/latest.json`);

// 6. the old version is no longer offered anywhere: delete its files
if (previous && previous !== version) {
  console.log(`\nRemoving the previous version (${previous}) from S3…`);
  await removeVersions([previous]);
}
