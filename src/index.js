const { app, BrowserWindow, ipcMain, powerMonitor, Tray, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { randomUUID } = require('crypto');
const { Worker } = require('worker_threads');

const IDLE_THRESHOLD_SECONDS = 60;
const IMAGES_DIR = path.join(__dirname, '..', 'images');

let mainWindow;
let tray;
let isQuitting = false;
let indexWorker;
let indexStatus = null;
const pendingSearches = new Map();

const createWindow = () => {

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 360,
    minHeight: 190,
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
  // mainWindow.webContents.openDevTools();

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
  tray.setToolTip('WithinFile');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open WithinFile', click: showMainWindow },
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

function startIndexWorker() {
  indexWorker = new Worker(path.join(__dirname, 'index-worker.js'), {
    workerData: {
      databasePath: path.join(app.getPath('userData'), 'file-index.sqlite'),
      roots: [app.getPath('documents')]
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
  app.on('ready', () => {
    startIndexWorker();
    createWindow();
    createTray();
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
