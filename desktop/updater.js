// Tether's own updater. The standard Electron updater (Squirrel.Mac / electron-updater) only works for apps
// signed with an Apple Developer ID; Tether is ad-hoc signed for now, so this does the same job by hand:
// check the feed on S3, download the new version in the background, verify it, and swap the app in place as
// soon as Tether is idle (never while sharing), then reopen it. Once Tether has a Developer ID, replace this
// with electron-updater (the release script already publishes latest-mac.yml for it).
import { app, Notification, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, writeFileSync } from 'node:fs';
import { access, constants, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;
const IDLE_POLL_MS = 60_000;

// "0.1.10" > "0.1.9": compare numerically, part by part.
export function isNewer(candidate, current) {
  const a = String(candidate).split('.').map(Number), b = String(current).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, (err, stdout, stderr) => (err ? reject(new Error(`${cmd}: ${stderr || err.message}`)) : resolve(stdout.trim()))));

// The Apple Team ID a bundle is signed with, or null (ad-hoc / unsigned). codesign prints details on stderr.
const teamOf = (bundle) => new Promise((resolve) =>
  execFile('/usr/bin/codesign', ['-dv', bundle], (_err, _out, stderr) => {
    const id = String(stderr).match(/^TeamIdentifier=(\S+)/m)?.[1];
    resolve(id && id !== 'not' ? id : null);
  }));

// GET with redirects, as a response stream.
function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'Cache-Control': 'no-cache' }, timeout: 30_000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

async function getJson(url) {
  const res = await get(url);
  let body = '';
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

// Stream to disk while hashing; reject unless size and SHA-256 match what the feed promised.
async function download(url, dest, { size, sha256 }) {
  const res = await get(url);
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const out = createWriteStream(dest);
    res.on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  if (size && bytes !== size) throw new Error(`size ${bytes}, expected ${size}`);
  if (hash.digest('hex') !== String(sha256).toLowerCase()) throw new Error('SHA-256 mismatch');
}

// Waits for Tether to exit, swaps the bundles (putting the old one back if anything fails), optionally reopens.
const INSTALL_SCRIPT = `#!/bin/sh
PID="$1"; APP="$2"; NEW="$3"; REOPEN="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
rm -rf "$APP.old"
if mv "$APP" "$APP.old"; then
  if mv "$NEW" "$APP"; then rm -rf "$APP.old"; else rm -rf "$APP"; mv "$APP.old" "$APP"; fi
fi
[ "$REOPEN" = "1" ] && open "$APP"
exit 0
`;

// Remove every trace of earlier versions. Runs at each launch of the packaged app:
//  - update downloads and the installer script left in the temp folder
//  - a Tether.app.old left behind by an interrupted swap
//  - mounted Tether installer disks (old .dmg windows) — never the one Tether runs from
//  - after an update: Tether's own stale Screen Recording and Accessibility entries, so System Settings doesn't
//    keep showing an old "Tether" that looks on but no longer works; macOS asks fresh on the next use
export async function cleanUpOldVersions() {
  if (!app.isPackaged) return;
  const appPath = path.resolve(process.execPath, '..', '..', '..');
  const temp = app.getPath('temp');
  const plistOf = (bundle) => path.join(bundle, 'Contents', 'Info.plist');
  const readPlist = (bundle, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistOf(bundle)]).catch(() => '');
  const bundleId = await readPlist(appPath, 'CFBundleIdentifier');

  const entries = await readdir(temp).catch(() => []);
  for (const name of entries) {
    if (name.startsWith('tether-update-') || name === 'tether-install.sh') await rm(path.join(temp, name), { recursive: true, force: true });
  }
  await rm(`${appPath}.old`, { recursive: true, force: true });

  if (bundleId && !appPath.startsWith('/Volumes/')) {
    for (const vol of await readdir('/Volumes').catch(() => [])) {
      const mounted = path.join('/Volumes', vol);
      if ((await readPlist(path.join(mounted, 'Tether.app'), 'CFBundleIdentifier')) === bundleId) {
        await run('/usr/bin/hdiutil', ['detach', mounted]).catch(() => {}); // busy disks just stay mounted
      }
    }
  }

  const marker = path.join(app.getPath('userData'), 'last-version');
  const previous = (await readFile(marker, 'utf8').catch(() => '')).trim();
  const current = app.getVersion();
  if (previous && previous !== current && bundleId) {
    for (const service of ['ScreenCapture', 'Accessibility']) await run('/usr/bin/tccutil', ['reset', service, bundleId]).catch(() => {});
  }
  if (previous !== current) await writeFile(marker, current).catch(() => {});
}

/**
 * @param {{ feedUrl: string, downloadUrl: string, isBusy: () => Promise<boolean>, onStatus: (s: object) => void }} opts
 */
export function startUpdater({ feedUrl, downloadUrl, isBusy, onStatus }) {
  const current = app.getVersion();
  // .../Tether.app/Contents/MacOS/Tether → .../Tether.app
  const appPath = path.resolve(process.execPath, '..', '..', '..');
  let status = { state: 'idle', current };
  let ready = null; // { version, newApp }
  let working = false;
  let installing = false;
  let toldManual = false;

  const setStatus = (s) => {
    status = { current, ...s };
    onStatus(status);
  };
  const notify = (title, body, onClick) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    if (onClick) n.on('click', onClick);
    n.show();
  };

  if (!app.isPackaged && !process.env.TETHER_UPDATE_FEED) {
    setStatus({ state: 'dev' });
    return { status: () => status };
  }

  // Updates need Tether in a folder it can write to (normally /Applications), not on the mounted DMG.
  async function canSelfUpdate() {
    if (appPath.startsWith('/Volumes/')) return 'move it to Applications to get updates';
    try {
      await access(path.dirname(appPath), constants.W_OK);
      await access(appPath, constants.W_OK);
      return null;
    } catch {
      return 'this Mac doesn\'t let Tether replace itself in its folder';
    }
  }

  async function prepare(feed) {
    const dir = path.join(app.getPath('temp'), `tether-update-${feed.version}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    try {
      const zip = path.join(dir, 'update.zip');
      setStatus({ state: 'downloading', available: feed.version });
      await download(feed.zip.url, zip, feed.zip);
      const unpacked = path.join(dir, 'unpacked');
      await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]); // keeps bundle metadata and signatures intact
      const newApp = path.join(unpacked, 'Tether.app');
      await stat(newApp);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', newApp]);
      // Once Tether is Developer ID signed, only accept updates signed by the same Apple team.
      const team = await teamOf(appPath);
      if (team && (await teamOf(newApp)) !== team) throw new Error(`update isn't signed by team ${team}`);
      const version = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
        path.join(newApp, 'Contents', 'Info.plist')]);
      if (version !== feed.version) throw new Error(`bundle is ${version}, feed said ${feed.version}`);
      await rm(zip, { force: true });
      return { version, newApp };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  // Synchronous on purpose: it also runs while the app is quitting.
  function install({ reopen }) {
    if (!ready || installing) return;
    if (!app.isPackaged) return setStatus({ state: 'ready', available: ready.version, dev: true }); // never swap a dev Electron
    installing = true;
    const script = path.join(app.getPath('temp'), 'tether-install.sh');
    writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
    spawn('/bin/sh', [script, String(process.pid), appPath, ready.newApp, reopen ? '1' : '0'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    if (reopen) {
      setStatus({ state: 'installing', available: ready.version });
      notify('Updating Tether', `Installing ${ready.version}. Tether reopens in a moment.`);
      app.quit();
    }
  }

  // Fully automatic: install as soon as Tether isn't sharing / showing the iPhone screen.
  async function installWhenIdle() {
    if (!ready || installing) return;
    const busy = await isBusy().catch(() => false);
    if (busy) return setStatus({ state: 'ready', available: ready.version, waiting: true });
    install({ reopen: true });
  }

  async function check() {
    if (working || ready || installing) return;
    working = true;
    try {
      setStatus({ state: 'checking' });
      const feed = await getJson(feedUrl);
      if (!feed?.version || !feed.zip?.url || !feed.zip?.sha256) throw new Error('feed is incomplete');
      if (!isNewer(feed.version, current)) return setStatus({ state: 'up-to-date' });
      const blocked = await canSelfUpdate();
      if (blocked) {
        setStatus({ state: 'manual', available: feed.version, reason: blocked });
        if (!toldManual) {
          toldManual = true;
          notify(`Tether ${feed.version} is available`, `To update automatically, ${blocked}. Click to download it.`,
            () => shell.openExternal(feed.dmg?.url || downloadUrl));
        }
        return;
      }
      ready = await prepare(feed);
      setStatus({ state: 'ready', available: ready.version });
      await installWhenIdle();
    } catch (err) {
      setStatus({ state: 'error', error: err.message }); // try again at the next check
    } finally {
      working = false;
    }
  }

  // Quitting with an update downloaded: install it on the way out (opens as the new version next time).
  app.on('before-quit', () => {
    if (ready && !installing) install({ reopen: false });
  });

  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  setInterval(installWhenIdle, IDLE_POLL_MS);
  return { status: () => status, check };
}
