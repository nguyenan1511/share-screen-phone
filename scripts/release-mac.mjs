// Publish a Tether release to S3:  npm run release:mac   (or: npm run release:mac -- --dry-run)
//
// 1. refuses with uncommitted changes, or when this version is already on S3
// 2. builds (npm run dist:mac → dist/Tether.dmg + dist/Tether-<version>-universal.zip)
// 3. writes latest.json (version, SHA-256 and size of the zip) — what the app's updater reads
// 4. uploads versioned files first, then the "always newest" Tether.dmg, latest-mac.yml, and latest.json LAST,
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
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  const Objects = old.flatMap((v) => [{ Key: `mac/${v}/Tether-${v}-universal.zip` }, { Key: `mac/${v}/Tether.dmg` }]);
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
const signArgs = identity ? ['--', `-c.mac.identity=${identity}`, '-c.mac.hardenedRuntime=true',
  '-c.mac.entitlements=assets/entitlements.mac.plist', '-c.mac.entitlementsInherit=assets/entitlements.mac.plist'] : [];
const built = spawnSync('npm', ['run', '-s', 'dist:mac', ...signArgs], {
  cwd: root,
  stdio: 'inherit',
  env: identity
    ? { ...process.env, TETHER_SIGN_IDENTITY: identity, APPLE_KEYCHAIN_PROFILE: notaryProfile }
    : { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
if (built.status !== 0) fail('build failed');
const dist = path.join(root, 'dist');
const zipName = `Tether-${version}-universal.zip`;
const zipPath = path.join(dist, zipName);
const dmgPath = path.join(dist, 'Tether.dmg');
for (const f of [zipPath, dmgPath]) if (!existsSync(f)) fail(`missing ${path.relative(root, f)}`);

// Signed builds: the app inside is already notarized + stapled by electron-builder; sign, notarize and staple the
// dmg too, then let Gatekeeper judge both the way a user's Mac will.
if (identity) {
  const step = (cmd, args, what) => {
    console.log(`  • ${what}`);
    if (spawnSync(cmd, args, { stdio: 'inherit' }).status !== 0) fail(`${what} failed`);
  };
  step('codesign', ['--force', '--sign', `Developer ID Application: ${identity}`, '--timestamp', dmgPath], 'signing the dmg');
  step('xcrun', ['notarytool', 'submit', dmgPath, '--keychain-profile', notaryProfile, '--wait'], 'notarizing the dmg (a few minutes)');
  step('xcrun', ['stapler', 'staple', dmgPath], 'stapling the dmg');
  step('spctl', ['--assess', '--type', 'execute', '-v', path.join(dist, 'mac-universal', 'Tether.app')], 'Gatekeeper check: app');
  step('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', dmgPath], 'Gatekeeper check: dmg');
}

// 3. latest.json
const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
const latest = {
  version,
  releasedAt: new Date().toISOString(),
  notes: process.env.TETHER_RELEASE_NOTES || '',
  zip: { url: `${base}/${version}/${zipName}`, sha256, size: statSync(zipPath).size },
  dmg: { url: `${base}/Tether.dmg` },
};

if (dryRun) {
  const out = path.join(dist, 'release', 'mac');
  mkdirSync(path.join(out, version), { recursive: true });
  copyFileSync(zipPath, path.join(out, version, zipName));
  copyFileSync(dmgPath, path.join(out, 'Tether.dmg'));
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
await put(`mac/${version}/${zipName}`, zipPath, 'application/zip', IMMUTABLE);
await put(`mac/${version}/Tether.dmg`, dmgPath, 'application/x-apple-diskimage', IMMUTABLE);
await put('mac/Tether.dmg', dmgPath, 'application/x-apple-diskimage', FRESH);
const yml = path.join(dist, 'latest-mac.yml');
if (existsSync(yml)) await put('mac/latest-mac.yml', yml, 'text/yaml', FRESH); // for electron-updater later
await put('mac/latest.json', JSON.stringify(latest, null, 2), 'application/json', FRESH);

// 5. confirm from the public URL
const check = await fetch(`${base}/latest.json`, { headers: { 'Cache-Control': 'no-cache' } }).then((r) => r.json()).catch(() => null);
if (check?.version !== version) fail(`public latest.json says ${check?.version ?? 'nothing'}, expected ${version}`);
console.log(`\n✓ Tether ${version} is live.\n  Download: ${base}/Tether.dmg\n  Feed:     ${base}/latest.json`);

// 6. the old version is no longer offered anywhere: delete its files
if (previous && previous !== version) {
  console.log(`\nRemoving the previous version (${previous}) from S3…`);
  await removeVersions([previous]);
}
