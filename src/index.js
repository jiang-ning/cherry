const { app, BrowserWindow, ipcMain, powerMonitor, Tray, Menu, screen, globalShortcut, shell, dialog, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const { Worker } = require('worker_threads');
const { DEFAULT_EXCLUDED_FOLDERS, DEFAULT_EXTENSIONS } = require('./search');

const IDLE_THRESHOLD_SECONDS = 60;
const IMAGES_DIR = path.join(__dirname, 'images');

let mainWindow;
let tray;
let isQuitting = false;
let indexWorker;
let indexStatus = null;
let indexPaths = [];
let indexExtensions = [];
let excludedFolders = [];
const pendingSearches = new Map();

const createWindow = () => {

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 800,
    height: 100,
    center: true,
    minWidth: 800,
    maxWidth: 800,
    minHeight: 100,
    resizeable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    titleBarStyle: 'hidden',
    // titleBarStyle: 'customButtonsOnHover', // for mac screenshot
    transparent: true,
    frame: false
  });

  mainWindow.on('closse', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // and load the index.html of the app.
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open the DevTools.
  mainWindow.webContents.openDevTools();

};

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(path.join(IMAGES_DIR, 'tray.png'));
  tray.setToolTip('Inwordia');
  tray.on('double-click', showMainWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Inwordia', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

ipcMain.on('minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle('is-minimized', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMinimized() ?? false;
});

let resizeTimer;

ipcMain.on('resize-to-content', (event, height) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !Number.isFinite(height)) return;
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const {width, x} = win.getBounds();
  const startHeight = win.getContentSize()[1];
  const target = Math.max(60, Math.min(Math.ceil(height), workArea.height));
  clearInterval(resizeTimer);
  if (target === startHeight) return;
  // Longer for bigger jumps (e.g. 0 -> many results) so it doesn't snap.
  const DURATION_MS = Math.min(320, 140 + Math.abs(target - startHeight) * 0.5);
  const startTime = Date.now();
  resizeTimer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(resizeTimer);
    const t = Math.min(1, (Date.now() - startTime) / DURATION_MS);
    const eased = 1 - (1 - t) ** 4;
    const h = Math.round(startHeight + (target - startHeight) * eased);
    // Keep the window vertically centered on the display as it grows.
    win.setBounds({ x, y: Math.round(workArea.y + (workArea.height - h) / 2), width, height: h });
    if (t === 1) clearInterval(resizeTimer);
  }, 16);
});

ipcMain.on('hide-to-tray', (event) => {
  if (process.platform !== 'win32') return;
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

ipcMain.on('close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle('search:start', (_event, keyword) => {
  const query = typeof keyword === 'string' ? keyword.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  if (!query) throw new Error('Enter a keyword to search.');
  if (!indexWorker) throw new Error('The search index is still starting.');

  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    pendingSearches.set(requestId, { resolve, reject });
    indexWorker.postMessage({ type: 'search', requestId, query });
  });
});

ipcMain.handle('index:status', () => indexStatus);

ipcMain.handle('index:disk-usage', async () => {
  const databasePath = getDatabasePath();
  // SQLite keeps recent writes in -wal/-shm side files, so they count toward the index size.
  const sizes = await Promise.all(['', '-wal', '-shm'].map((suffix) =>
    fs.stat(databasePath + suffix).then((stat) => stat.size, () => 0)
  ));
  const disk = await fs.statfs(path.dirname(databasePath));
  return {
    indexBytes: sizes.reduce((sum, size) => sum + size, 0),
    totalBytes: disk.blocks * disk.bsize,
    freeBytes: disk.bavail * disk.bsize
  };
});

ipcMain.handle('index-paths:get', () => indexPaths);

ipcMain.handle('index-paths:add', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Add Index Path',
    properties: ['openDirectory', 'multiSelections']
  });
  if (canceled) return indexPaths;
  const added = filePaths.filter((folder) => !indexPaths.includes(folder));
  return added.length ? applyIndexPaths([...indexPaths, ...added]) : indexPaths;
});

ipcMain.handle('index-paths:remove', (_event, folder) => {
  if (!indexPaths.includes(folder)) return indexPaths;
  return applyIndexPaths(indexPaths.filter((item) => item !== folder));
});

ipcMain.handle('index-extensions:get', () => indexExtensions);

ipcMain.handle('index-extensions:add', (_event, input) => {
  const extension = normalizeExtension(input);
  if (!extension) throw new Error('Enter an extension such as .txt');
  if (indexExtensions.includes(extension)) return indexExtensions;
  return applyIndexExtensions([...indexExtensions, extension]);
});

ipcMain.handle('index-extensions:remove', (_event, extension) => {
  if (!indexExtensions.includes(extension)) return indexExtensions;
  return applyIndexExtensions(indexExtensions.filter((item) => item !== extension));
});

ipcMain.handle('excluded-folders:get', () => excludedFolders);

ipcMain.handle('excluded-folders:add', (_event, input) => {
  const name = normalizeFolderName(input);
  if (!name) throw new Error('Enter a folder name, not a path');
  if (excludedFolders.some((item) => item.toLowerCase() === name.toLowerCase())) return excludedFolders;
  return applyExcludedFolders([...excludedFolders, name]);
});

ipcMain.handle('excluded-folders:remove', (_event, name) => {
  if (!excludedFolders.includes(name)) return excludedFolders;
  return applyExcludedFolders(excludedFolders.filter((item) => item !== name));
});

function normalizeFolderName(input) {
  if (typeof input !== 'string') return null;
  const name = input.trim();
  return name && name.length <= 255 && !/[\\/:*?"<>|]/.test(name) && name !== '.' && name !== '..' ? name : null;
}

function normalizeExtension(input) {
  if (typeof input !== 'string') return null;
  const extension = '.' + input.trim().toLowerCase().replace(/^\*?\./, '');
  return /^\.[a-z0-9_+-]{1,16}$/.test(extension) ? extension : null;
}

const DEFAULT_HOTKEY = 'Control+Shift+Space';
let hotkey = DEFAULT_HOTKEY;

ipcMain.handle('hotkey:get', () => hotkey);

ipcMain.handle('hotkey:set', async (_event, accelerator) => {
  if (typeof accelerator !== 'string' || !/^[\w+]+$/.test(accelerator)) throw new Error('Invalid hotkey.');
  if (accelerator === hotkey) return hotkey;
  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, showMainWindow);
  } catch {
    throw new Error('This combination is not supported.');
  }
  if (!registered) throw new Error('This combination is already in use by another application.');
  globalShortcut.unregister(hotkey);
  hotkey = accelerator;
  await saveSettings();
  return hotkey;
});

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  let settings = {};
  try {
    settings = JSON.parse(await fs.readFile(getSettingsPath(), 'utf8'));
  } catch {
    // Missing or unreadable settings fall back to the defaults.
  }
  indexPaths = Array.isArray(settings.indexPaths)
    ? settings.indexPaths.filter((item) => typeof item === 'string')
    : [app.getPath('documents')];
  indexExtensions = Array.isArray(settings.indexExtensions)
    ? settings.indexExtensions.map(normalizeExtension).filter(Boolean)
    : [...DEFAULT_EXTENSIONS];
  excludedFolders = Array.isArray(settings.excludedFolders)
    ? settings.excludedFolders.map(normalizeFolderName).filter(Boolean)
    : [...DEFAULT_EXCLUDED_FOLDERS];
  if (typeof settings.hotkey === 'string' && /^[\w+]+$/.test(settings.hotkey)) hotkey = settings.hotkey;
}

function saveSettings() {
  return fs.writeFile(getSettingsPath(), JSON.stringify({ indexPaths, indexExtensions, excludedFolders, hotkey }, null, 2));
}

async function applyIndexPaths(paths) {
  indexPaths = paths;
  await saveSettings();
  indexWorker?.postMessage({ type: 'set-roots', roots: indexPaths });
  return indexPaths;
}

async function applyIndexExtensions(extensions) {
  indexExtensions = extensions;
  await saveSettings();
  indexWorker?.postMessage({ type: 'set-extensions', extensions: indexExtensions });
  return indexExtensions;
}

async function applyExcludedFolders(folders) {
  excludedFolders = folders;
  await saveSettings();
  indexWorker?.postMessage({ type: 'set-excluded-folders', excludedFolders });
  return excludedFolders;
}

ipcMain.handle('file:open', (_event, filePath) => {
  if (typeof filePath !== 'string') return 'Invalid path';
  return shell.openPath(filePath);
});

ipcMain.handle('file:show-in-folder', (_event, filePath) => {
  if (typeof filePath !== 'string') return;
  shell.showItemInFolder(filePath);
});

function handleWorkerMessage(message) {
  if (message.type === 'status') {
    indexStatus = message.status;
    mainWindow?.webContents.send('index:status', indexStatus);
    return;
  }

  if (message.type === 'search-response') {
    const pending = pendingSearches.get(message.requestId);
    if (!pending) return;
    pendingSearches.delete(message.requestId);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      indexStatus = message.status;
      pending.resolve({ results: message.results, limitReached: message.limitReached, status: message.status });
    }
  }
}

function failPendingSearches(reason) {
  for (const { reject } of pendingSearches.values()) reject(new Error(reason));
  pendingSearches.clear();
}

function getDatabasePath() {
  return path.join(app.getPath('userData'), 'file-index.sqlite');
}

function startIndexWorker() {
  indexWorker = new Worker(path.join(__dirname, 'index-worker.js'), {
    workerData: {
      databasePath: getDatabasePath(),
      roots: indexPaths,
      extensions: indexExtensions,
      excludedFolders
    }
  });
  indexWorker.on('message', handleWorkerMessage);
  indexWorker.on('error', (error) => {
    indexStatus = { ...indexStatus, error: error.message };
    mainWindow?.webContents.send('index:status', indexStatus);
  });
  indexWorker.on('exit', () => {
    indexWorker = null;
    failPendingSearches('The search index stopped.');
  });

  const reportIdle = () => {
    indexWorker?.postMessage({ type: 'idle', idle: powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SECONDS });
  }
  setInterval(reportIdle, 15 * 1000).unref();
  reportIdle();
}

if(!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  // Also covers quitting from outside the tray menu, such as a system shutdown or an installer update.
  app.on('before-quit', () => {
    isQuitting = true;
  });

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.on('ready', async () => {
    nativeTheme.themeSource = 'system';
    await loadSettings();
    startIndexWorker();
    createWindow();
    createTray();
    if (process.platform === 'win32' && !globalShortcut.register(hotkey, showMainWindow)) {
      hotkey = DEFAULT_HOTKEY;
      globalShortcut.register(hotkey, showMainWindow);
    }
  });
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // if (process.platform !== 'darwin') {
  app.quit();
  // }
});

app.on('activate', showMainWindow);

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
