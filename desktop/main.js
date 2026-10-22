// Tether for Mac (Electron): runs the same local server as `npm start`, with the prebuilt macOS
// helper, and shows the laptop page in its own window. Phones still connect to this Mac over Wi-Fi.
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell, systemPreferences } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanUpOldVersions, startUpdater } from './updater.js';

// Update feed and download link live in package.json ("tether"), so changing the bucket is one edit.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (!app.requestSingleInstanceLock()) app.quit();

// Inside the packaged app the helper sits in Contents/Resources (outside the read-only app archive).
if (app.isPackaged) process.env.PHONE_SCREEN_HELPER ||= path.join(process.resourcesPath, 'phone-display');
process.env.PORT ||= '3001';

await import('../server.js');
const serverReady = globalThis.tetherServerReady;

let win = null;

const SCREEN_RECORDING_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

// Without Screen Recording permission macOS gives the app no screens at all. Say so (with a way to fix it)
// instead of failing silently. Ad-hoc signed builds count as a new app after every update, so this can
// also happen when Tether still looks switched on in System Settings.
//
// "Fix it" clears only Tether's own Screen Recording entry (`tccutil reset ScreenCapture <bundle id>`, no admin
// needed) — the stale grant macOS keeps for an earlier build — then asks for capture so macOS shows its fresh
// "allow screen recording" prompt, and opens the right Settings page. Same as removing and re-adding it by hand.
async function explainScreenPermission() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: 'Tether needs Screen Recording permission',
    detail:
      'Click Fix it, then turn on Tether in Screen & System Audio Recording and choose Quit & Reopen.\n\n' +
      'This happens after updates until Tether is verified by Apple: macOS keeps the permission for the old ' +
      'version, so it looks on but doesn\'t work.',
    buttons: ['Fix it', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  await resetScreenPermission();
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => {});
  shell.openExternal(SCREEN_RECORDING_SETTINGS);
}

function resetScreenPermission() {
  if (!app.isPackaged) return Promise.resolve(); // dev runs borrow Terminal's permission; nothing to reset
  const plist = path.join(path.dirname(process.execPath), '..', 'Info.plist');
  return new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], (err, id) => {
      if (err || !id.trim()) return resolve();
      execFile('/usr/bin/tccutil', ['reset', 'ScreenCapture', id.trim()], () => resolve());
    });
  });
}

// The page reports a failed share (AbortError etc.): in the app that almost always means this permission,
// unless the user just cancelled our own screen picker.
let userCancelledAt = 0;
ipcMain.handle('tether:share-failed', () => (Date.now() - userCancelledAt < 5000 ? null : explainScreenPermission()));

// Share screen: when the iPhone screen exists, share it right away (no picker). Otherwise ask which screen.
function handleScreenRequests(port) {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources.length || systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        userCancelledAt = Date.now(); // the dialog below is the explanation; don't show a second one
        callback({});
        return explainScreenPermission();
      }
      const display = await fetch(`http://localhost:${port}/api/display`).then((r) => r.json()).catch(() => null);
      const iphone = display?.active && sources.find((s) => s.display_id === String(display.displayID));
      if (iphone) return callback({ video: iphone });
      if (sources.length === 1) return callback({ video: sources[0] });
      const names = sources.map((s, i) => (s.name && s.name !== 'Entire screen' ? s.name : `Screen ${i + 1}`));
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        message: 'Which screen should the iPhone show?',
        buttons: [...names, 'Cancel'],
        cancelId: names.length,
      });
      if (response >= sources.length) userCancelledAt = Date.now();
      callback(response < sources.length ? { video: sources[response] } : {});
    } catch {
      callback({});
    }
  });
}

async function openWindow() {
  const port = await serverReady;
  handleScreenRequests(port);
  win = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    title: 'Tether',
    backgroundColor: '#f5f5f7',
    webPreferences: { contextIsolation: true, sandbox: true, preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) },
  });
  const home = `http://localhost:${port}/`;
  // The drop-zone box opens as a real window; everything else (room links, help) goes to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${home}zone`)) {
      return { action: 'allow', overrideBrowserWindowOptions: { title: 'iPhone drop zone', alwaysOnTop: false } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(home)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on('closed', () => (win = null));
  await win.loadURL(home);
  startUpdates();
}

// Automatic updates (desktop/updater.js). "Busy" = sharing or the iPhone screen is added: never update then.
let updater = null;
let lastStatus = null;
function startUpdates() {
  if (updater) return;
  updater = startUpdater({
    feedUrl: process.env.TETHER_UPDATE_FEED || pkg.tether.updateFeed,
    downloadUrl: pkg.tether.downloadUrl,
    isBusy: async () => Boolean(win && (await win.webContents.executeJavaScript('window.tetherBusy ? window.tetherBusy() : false'))),
    onStatus: (status) => {
      lastStatus = status;
      win?.webContents.send('tether:update', status);
    },
  });
}
ipcMain.on('tether:update-request', (event) => lastStatus && event.sender.send('tether:update', lastStatus));

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// The server and the iPhone screen only make sense while the window is open: closing it quits
// (the server's exit handler removes the iPhone screen and brings the cursor home).
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  cleanUpOldVersions().catch(() => {});
  return openWindow();
});
