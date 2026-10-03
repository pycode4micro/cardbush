// Test-only IPC. Agent credentials stay in the Electron main process.
const { ipcRenderer } = require('electron');
window.remoteDesktopTest = {
  info: () => ipcRenderer.invoke('desktop-live-info'),
  call: (operation, input) => ipcRenderer.invoke('desktop-live-call', operation, input),
};
