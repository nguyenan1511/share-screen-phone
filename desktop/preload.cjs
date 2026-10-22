// Gives the laptop page the app version and update status (only inside the Tether Mac app).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tether', {
  // Sharing failed in the app: let the main process explain / fix Screen Recording permission.
  shareFailed: () => ipcRenderer.invoke('tether:share-failed'),
  onUpdate: (callback) => {
    ipcRenderer.on('tether:update', (_event, status) => callback(status));
    ipcRenderer.send('tether:update-request');
  },
});
