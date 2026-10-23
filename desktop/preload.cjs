// Gives the laptop page the platform and update status (only inside the Tether app, Mac or Windows).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tether', {
  platform: process.platform, // 'darwin' | 'win32'
  // Sharing failed in the app: let the main process explain / fix Screen Recording permission.
  shareFailed: () => ipcRenderer.invoke('tether:share-failed'),
  onUpdate: (callback) => {
    ipcRenderer.on('tether:update', (_event, status) => callback(status));
    ipcRenderer.send('tether:update-request');
  },
});
