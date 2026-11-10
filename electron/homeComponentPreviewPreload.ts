import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('componentPreview', {
  read: () => ipcRenderer.invoke('component-preview:read'),
  ready: () => ipcRenderer.send('component-preview:ready'),
});
