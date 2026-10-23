// Publish Tether for Windows to S3:  npm run release:win   (or: npm run release:win -- --dry-run)
//
// Built on this Mac with electron-builder (NSIS installer, x64, unsigned: Windows SmartScreen asks once,
// "More info → Run anyway"). Same steps as release-mac.mjs:
// 1. refuses with uncommitted changes, or when this version is already on S3
// 2. builds dist/Tether-Setup-<version>.exe
// 3. uploads it versioned, then the "always newest" Tether-Setup.exe, then latest.json LAST
// 4. reads latest.json back from the public URL, then deletes the previous version's installer
//
// Files live under mac/windows/ because the bucket's public-read policy and the upload key both cover mac/* only.
// The installed app reads mac/windows/latest.json (desktop/updater.js: `setup`).
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dryRun = process.argv.includes('--dry-run');
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

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const { AWS_REGION: region, TETHER_S3_BUCKET: bucket } = process.env;
if (!dryRun) {
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'TETHER_S3_BUCKET']) {
    if (!process.env[k]) fail(`${k} is missing (put it in .env.release)`);
  }
}
const PREFIX = 'mac/windows';
const base = dryRun ? (process.env.TETHER_RELEASE_BASE || `http://localhost:8099/${PREFIX}`) : `https://${bucket}.s3.${region}.amazonaws.com/${PREFIX}`;
const setupName = `Tether-Setup-${version}.exe`;

// 1. safety checks
let previous = null;
if (!dryRun) {
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
    fail('commit your changes first (the release must match a commit)');
  }
  if ((await fetch(`${base}/${version}/${setupName}`, { method: 'HEAD' })).ok) {
    fail(`${version} for Windows is already on S3 — bump the version (npm version patch --no-git-tag-version)`);
  }
  previous = await fetch(`${base}/latest.json`, { headers: { 'Cache-Control': 'no-cache' } })
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.version ?? null).catch(() => null);
}

// 2. build
console.log(`Building Tether ${version} for Windows… (unsigned)`);
const built = spawnSync('npm', ['run', '-s', 'dist:win'], { cwd: root, stdio: 'inherit' });
if (built.status !== 0) fail('build failed');
const setup = path.join(root, 'dist', setupName);
if (!existsSync(setup)) fail(`missing ${path.relative(root, setup)}`);

const latest = {
  version,
  releasedAt: new Date().toISOString(),
  notes: process.env.TETHER_RELEASE_NOTES || '',
  setup: { url: `${base}/${version}/${setupName}`, sha256: createHash('sha256').update(readFileSync(setup)).digest('hex'), size: statSync(setup).size },
  download: `${base}/Tether-Setup.exe`,
};
console.log(`\nInstaller: ${(latest.setup.size / 1e6).toFixed(0)} MB`);

if (dryRun) {
  const out = path.join(root, 'dist', 'release', PREFIX);
  mkdirSync(path.join(out, version), { recursive: true });
  copyFileSync(setup, path.join(out, version, setupName));
  copyFileSync(setup, path.join(out, 'Tether-Setup.exe'));
  writeFileSync(path.join(out, 'latest.json'), JSON.stringify(latest, null, 2));
  console.log(`\nDry run: ${path.relative(root, out)}/ has latest.json and the installer (feed base ${base}).`);
  process.exit(0);
}

// 3. upload (latest.json last)
const s3 = new S3Client({ region });
async function put(key, file, contentType, cacheControl) {
  const isFile = typeof file === 'string' && existsSync(file);
  process.stdout.write(`  ↑ ${key} … `);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: isFile ? createReadStream(file) : file,
    ContentLength: isFile ? statSync(file).size : Buffer.byteLength(file), ContentType: contentType, CacheControl: cacheControl,
  }));
  console.log('done');
}
console.log(`\nUploading to s3://${bucket}/${PREFIX}/ …`);
const EXE = 'application/vnd.microsoft.portable-executable';
await put(`${PREFIX}/${version}/${setupName}`, setup, EXE, 'public, max-age=31536000, immutable');
await put(`${PREFIX}/Tether-Setup.exe`, setup, EXE, 'no-cache');
await put(`${PREFIX}/latest.json`, JSON.stringify(latest, null, 2), 'application/json', 'no-cache');

// 4. confirm, then remove the previous version
const check = await fetch(`${base}/latest.json`, { headers: { 'Cache-Control': 'no-cache' } }).then((r) => r.json()).catch(() => null);
if (check?.version !== version) fail(`public latest.json says ${check?.version ?? 'nothing'}, expected ${version}`);
console.log(`\n✓ Tether ${version} for Windows is live.\n  Download: ${latest.download}\n  Feed:     ${base}/latest.json`);

if (previous && previous !== version) {
  console.log(`\nRemoving the previous Windows version (${previous}) from S3…`);
  const Key = `${PREFIX}/${previous}/Tether-Setup-${previous}.exe`;
  const res = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key }], Quiet: true } }));
  if (res.Errors?.length) fail(`could not delete ${res.Errors.map((e) => `${e.Key} (${e.Code})`).join(', ')}`);
  console.log(`  ✕ ${Key} … removed`);
}
