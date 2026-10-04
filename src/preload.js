// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

const { contextBridge, ipcRenderer } = require("electron/renderer");

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('minimize'),
  isMinimized: () => ipcRenderer.invoke('is-minimized'),
  close: () => ipcRenderer.send('close'),
  hideToTray: () => ipcRenderer.send('hide-to-tray'),
  resizeToContent: (height) => ipcRenderer.send('resize-to-content', height),
  search: (keyword) => ipcRenderer.invoke('search:start', keyword),
  getIndexStatus: () => ipcRenderer.invoke('index:status'),
  getDiskUsage: () => ipcRenderer.invoke('index:disk-usage'),
  getIndexPaths: () => ipcRenderer.invoke('index-paths:get'),
  addIndexPath: () => ipcRenderer.invoke('index-paths:add'),
  removeIndexPath: (folder) => ipcRenderer.invoke('index-paths:remove', folder),
  openFile: (filePath) => ipcRenderer.invoke('file:open', filePath),
  openFolder: (filePath) => ipcRenderer.invoke('file:show-in-folder', filePath),
  onIndexStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('index:status', listener);
    return () => ipcRenderer.removeListener('index:status', listener);
  },
});
