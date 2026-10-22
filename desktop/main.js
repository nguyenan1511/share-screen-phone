// Tether for Mac (Electron): runs the same local server as `npm start`, with the prebuilt macOS
// helper, and shows the laptop page in its own window. Phones still connect to this Mac over Wi-Fi.
import { app, BrowserWindow, desktopCapturer, dialog, session, shell, systemPreferences } from 'electron';
import path from 'node:path';

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
async function explainScreenPermission() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: 'Tether needs Screen Recording permission',
    detail:
      'Open System Settings → Privacy & Security → Screen & System Audio Recording and turn on Tether, ' +
      'then quit and reopen Tether.\n\nAlready on? After an update macOS may not count it: select Tether, ' +
      'remove it with −, add it again with +, then reopen Tether.',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) shell.openExternal(SCREEN_RECORDING_SETTINGS);
}

// Share screen: when the iPhone screen exists, share it right away (no picker). Otherwise ask which screen.
function handleScreenRequests(port) {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      if (!sources.length || systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
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
    webPreferences: { contextIsolation: true, sandbox: true },
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
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// The server and the iPhone screen only make sense while the window is open: closing it quits
// (the server's exit handler removes the iPhone screen and brings the cursor home).
app.on('window-all-closed', () => app.quit());

app.whenReady().then(openWindow);
