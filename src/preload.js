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
  getIndexLocation: () => ipcRenderer.invoke('index:location'),
  getDiskUsage: () => ipcRenderer.invoke('index:disk-usage'),
  setIndexPaused: (paused) => ipcRenderer.invoke('index:set-paused', paused),
  clearIndex: () => ipcRenderer.invoke('index:clear'),
  getIndexPaths: () => ipcRenderer.invoke('index-paths:get'),
  addIndexPath: () => ipcRenderer.invoke('index-paths:add'),
  removeIndexPath: (folder) => ipcRenderer.invoke('index-paths:remove', folder),
  getIndexExtensions: () => ipcRenderer.invoke('index-extensions:get'),
  addIndexExtension: (extension) => ipcRenderer.invoke('index-extensions:add', extension),
  removeIndexExtension: (extension) => ipcRenderer.invoke('index-extensions:remove', extension),
  getExcludedFolders: () => ipcRenderer.invoke('excluded-folders:get'),
  addExcludedFolder: (name) => ipcRenderer.invoke('excluded-folders:add', name),
  removeExcludedFolder: (name) => ipcRenderer.invoke('excluded-folders:remove', name),
  getMaxFileSize: () => ipcRenderer.invoke('max-file-size:get'),
  setMaxFileSize: (sizeMB) => ipcRenderer.invoke('max-file-size:set', sizeMB),
  getHotkey: () => ipcRenderer.invoke('hotkey:get'),
  setHotkey: (accelerator) => ipcRenderer.invoke('hotkey:set', accelerator),
  getLaunchAtStartup: () => ipcRenderer.invoke('launch-at-startup:get'),
  setLaunchAtStartup: (enabled) => ipcRenderer.invoke('launch-at-startup:set', enabled),
  getCaseSensitive: () => ipcRenderer.invoke('case-sensitive:get'),
  setCaseSensitive: (enabled) => ipcRenderer.invoke('case-sensitive:set', enabled),
  getSearchFileNames: () => ipcRenderer.invoke('search-file-names:get'),
  setSearchFileNames: (enabled) => ipcRenderer.invoke('search-file-names:set', enabled),
  getMaxResults: () => ipcRenderer.invoke('max-results:get'),
  setMaxResults: (value) => ipcRenderer.invoke('max-results:set', value),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  openFile: (filePath) => ipcRenderer.invoke('file:open', filePath),
  openFolder: (filePath) => ipcRenderer.invoke('file:show-in-folder', filePath),
  onIndexStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('index:status', listener);
    return () => ipcRenderer.removeListener('index:status', listener);
  },
});
