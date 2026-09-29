// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { contextBridge, ipcRenderer } = require("electron/renderer");

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('minimize'),
  isMinimized: () => ipcRenderer.invoke('is-minimized'),
  close: () => ipcRenderer.send('close'),
  search: (keyword) => ipcRenderer.invoke('search:start', keyword),
  getIndexStatus: () => ipcRenderer.invoke('index:status'),
  onIndexStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('index:status', listener);
    return () => ipcRenderer.removeListener('index:status', listener);
  },
});
