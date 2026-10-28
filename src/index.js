const { app, BrowserWindow, ipcMain, powerMonitor, Tray, Menu, screen, globalShortcut, shell, dialog, nativeTheme, net } = require('electron');
if (require('electron-squirrel-startup')) app.quit();
// const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs/promises');
const { randomUUID } = require('crypto');
const { Worker } = require('worker_threads');
const { 
  DEFAULT_EXCLUDED_FOLDERS, DEFAULT_EXTENSIONS, DEFAULT_MAX_FILE_SIZE_MB, LEGACY_DEFAULT_EXTENSIONS, MIN_FILE_SIZE_MB, MAX_FILE_SIZE_MB
} = require('./search');
const { Languages } = require('./lang');
const { OcrLanguages } = require('./ocr-languages');
const { BUNDLED_LANGUAGES } = require('./ocr');

const IDLE_THRESHOLD_SECONDS = 60;
const WORKER_RESTART_DELAY_MS = 5000;
const IMAGES_DIR = path.join(__dirname, 'images');
// The same files the @tesseract.js-data packages ship, pinned to their only version.
const OCR_DATA_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/{code}@1.0.0/4.0.0_best_int/{code}.traineddata.gz';
const OCR_DATA_SUFFIX = '.traineddata.gz';
const MAX_OCR_DATA_BYTES = 64 * 1024 * 1024;
const OCR_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

let mainWindow;
let tray;
let isQuitting = false;
let indexWorker;
let idleReporter = null;
let indexStatus = null;
let indexPaths = [];
let indexExtensions = [];
let excludedFolders = [];
let maxFileSizeMB = DEFAULT_MAX_FILE_SIZE_MB;
const pendingRequests = new Map();

const LOGIN_ARGS = ['--hidden'];
let startHidden = process.argv.includes('--hidden');
let launchAtStartup = false;
let caseSensitive = false;
let searchFileNames = false;
let maxResults = 500;
let indexPaused = false;
let language = 'en';
// Tesseract codes from ocr-languages.js; English is always first.
let ocrLanguages = ['eng'];
const ocrDownloads = new Map();

function translate(wordsCode) {
  return (Languages[language] || Languages.en)[wordsCode] || false;
}

const createWindow = () => {
  const show = !startHidden;
  startHidden = false;

  // Create the browser window.
  mainWindow = new BrowserWindow({
    show,
    width: 800,
    height: 100,
    center: true,
    minWidth: 800,
    maxWidth: 800,
    resizeble: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : {}),
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
  tray.setToolTip('CherryQuery');
  tray.on('double-click', showMainWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${translate('__open_cherryquery__') || 'Open'} CherryQuery`, click: showMainWindow },
    { type: 'separator' },
    {
      label: translate('__exit__') || 'Exit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

ipcMain.handle('language:set', async (_event, value) => {
  if (!Object.hasOwn(Languages, value)) throw new Error('Invalid language.');
  if (value === language) return language;
  language = value;
  updateTrayMenu();
  await saveSettings();
  // The app language is preset for text recognition; the user can remove it again.
  const ocrCode = Languages[language].ocr;
  if (!ocrLanguages.includes(ocrCode)) await applyOcrLanguages([...ocrLanguages, ocrCode]);
  return language;
});

// Holds downloaded language data; the index worker also combines languages here for OCR.
function getOcrDataDir() {
  return path.join(app.getPath('userData'), 'ocr-languages');
}

const ocrDataFile = (code) => path.join(getOcrDataDir(), code + OCR_DATA_SUFFIX);

async function downloadedOcrLanguages() {
  const names = await fs.readdir(getOcrDataDir()).catch(() => []);
  return names.filter((name) => name.endsWith(OCR_DATA_SUFFIX))
    .map((name) => name.slice(0, -OCR_DATA_SUFFIX.length))
    .filter((code) => Object.hasOwn(OcrLanguages, code));
}

// `code` must be a key of OcrLanguages, which keeps the URL and file name safe.
function downloadOcrLanguage(code) {
  if (!ocrDownloads.has(code)) {
    const download = (async () => {
      const response = await net.fetch(OCR_DATA_URL.replaceAll('{code}', code), {
        signal: AbortSignal.timeout(OCR_DOWNLOAD_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);
      if (Number(response.headers.get('content-length')) > MAX_OCR_DATA_BYTES) throw new Error('Download too large.');
      const data = Buffer.from(await response.arrayBuffer());
      // Language data is gzip-compressed, so anything else isn't language data.
      if (data.length > MAX_OCR_DATA_BYTES || data[0] !== 0x1f || data[1] !== 0x8b) {
        throw new Error('The downloaded language data is not valid.');
      }
      await fs.mkdir(getOcrDataDir(), { recursive: true });
      const partial = `${ocrDataFile(code)}.download`;
      await fs.writeFile(partial, data);
      await fs.rename(partial, ocrDataFile(code));
    })().finally(() => ocrDownloads.delete(code));
    ocrDownloads.set(code, download);
  }
  return ocrDownloads.get(code);
}

async function applyOcrLanguages(list) {
  ocrLanguages = ['eng', ...list.filter((code) => code !== 'eng')];
  await saveSettings();
  indexWorker?.postMessage({ type: 'set-ocr-languages', languages: ocrLanguages });
  return ocrLanguages;
}

ipcMain.handle('ocr-languages:get', async () => ({
  selected: ocrLanguages,
  available: [...new Set([...BUNDLED_LANGUAGES, ...await downloadedOcrLanguages()])]
}));

ipcMain.handle('ocr-languages:add', async (_event, code) => {
  if (typeof code !== 'string' || !Object.hasOwn(OcrLanguages, code)) throw new Error('Invalid language.');
  if (ocrLanguages.includes(code)) return ocrLanguages;
  if (!BUNDLED_LANGUAGES.has(code) && !(await downloadedOcrLanguages()).includes(code)) {
    await downloadOcrLanguage(code);
  }
  // The selection may have changed during the download.
  return ocrLanguages.includes(code) ? ocrLanguages : applyOcrLanguages([...ocrLanguages, code]);
});

ipcMain.handle('ocr-languages:remove', (_event, code) => {
  if (code === 'eng' || !ocrLanguages.includes(code)) return ocrLanguages;
  return applyOcrLanguages(ocrLanguages.filter((item) => item !== code));
});

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
    pendingRequests.set(requestId, { resolve, reject });
    indexWorker.postMessage({ type: 'search', requestId, query, caseSensitive, searchFileNames, maxResults });
  });
});

ipcMain.handle('index:status', () => indexStatus);

// Only files with an OCR layout in the index get a thumbnail, so arbitrary paths are never opened.
ipcMain.handle('ocr:thumbnail', (_event, filePath, start, length) => {
  if (!indexWorker || typeof filePath !== 'string') return null;
  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0) return null;
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    indexWorker.postMessage({ type: 'ocr-thumbnail', requestId, filePath, start, length });
  });
});
ipcMain.handle('index:location', () => getDatabasePath());

ipcMain.handle('index:set-paused', async (_event, paused) => {
  if (typeof paused !== 'boolean') throw new Error('Invalid value.');
  if (!indexWorker) throw new Error('The search index is not running.');
  indexPaused = paused;
  await saveSettings();
  indexWorker.postMessage({ type: 'set-paused', paused });
  return paused;
});

ipcMain.handle('index:clear', async (event) => {
  if (!indexWorker) throw new Error('The search index is not running.');
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [translate('__clear_index__') || 'Clear Index', translate('__cancel__') || 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: translate('__clear_index__') || 'Clear Index',
    message: translate('__clear_the_index_db__') || 'Clear the index database?',
    detail: translate('__clear_index_detail__') || 'All indexed content will be removed. Indexing stays paused untill you click Resume Index.'
  });
  if (response !== 0) return false;

  // Pause first so the worker does not start rebuilding the index as soon as it is cleared.
  indexPaused = true;
  await saveSettings();
  indexWorker.postMessage({ type: 'set-paused', paused: true });
  const requestId = randomUUID();
  await new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    indexWorker.postMessage({ type: 'clear', requestId });
  });
  return true;
});

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

ipcMain.handle('max-file-size:get', () => maxFileSizeMB);

ipcMain.handle('max-file-size:set', async (_event, value) => {
  if (!isValidMaxFileSize(value)) throw new Error('Invalid maximum file size.');
  if (value === maxFileSizeMB) return maxFileSizeMB;
  maxFileSizeMB = value;
  await saveSettings();
  indexWorker?.postMessage({ type: 'set-max-file-size', maxFileSizeMB });
  return maxFileSizeMB;
});

function isValidMaxFileSize(value) {
  return Number.isInteger(value) && value >= MIN_FILE_SIZE_MB && value <= MAX_FILE_SIZE_MB;
}

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
const THEMES = ['system', 'light', 'dark'];
let theme = 'system';

ipcMain.handle('launch-at-startup:get', () => launchAtStartup);

ipcMain.handle('launch-at-startup:set', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Invalid value.');
  app.setLoginItemSettings({ openAtLogin: enabled, args: LOGIN_ARGS });
  launchAtStartup = enabled;
  await saveSettings();
  return launchAtStartup;
});

ipcMain.handle('case-sensitive:get', () => caseSensitive);

ipcMain.handle('case-sensitive:set', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Invalid value.');
  caseSensitive = enabled;
  await saveSettings();
  return caseSensitive;
});

ipcMain.handle('search-file-names:get', () => searchFileNames);

ipcMain.handle('search-file-names:set', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Invalid value.');
  searchFileNames = enabled;
  await saveSettings();
  return searchFileNames;
});

ipcMain.handle('max-results:get', () => maxResults);

ipcMain.handle('max-results:set', async (_event, value) => {
  if (!isValidMaxResults(value)) throw new Error('Invalid maximum results.');
  maxResults = value;
  await saveSettings();
  return maxResults;
});

function isValidMaxResults(value) {
  return Number.isInteger(value) && value >= 100 && value <= 1000;
}

ipcMain.handle('theme:get', () => theme);

ipcMain.handle('theme:set', async (_event, value) => {
  if (!THEMES.includes(value)) throw new Error('Invalid theme.');
  theme = value;
  nativeTheme.themeSource = theme;
  await saveSettings();
  return theme;
});

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
  // Add defaults introduced since the settings were saved, without restoring ones the user removed.
  const knownDefaults = Array.isArray(settings.defaultExtensions) ? settings.defaultExtensions : LEGACY_DEFAULT_EXTENSIONS;
  indexExtensions.push(...DEFAULT_EXTENSIONS.filter(
    (extension) => !knownDefaults.includes(extension) && !indexExtensions.includes(extension)
  ));
  excludedFolders = Array.isArray(settings.excludedFolders)
    ? settings.excludedFolders.map(normalizeFolderName).filter(Boolean)
    : [...DEFAULT_EXCLUDED_FOLDERS];
  if (typeof settings.hotkey === 'string' && /^[\w+]+$/.test(settings.hotkey)) hotkey = settings.hotkey;
  if (THEMES.includes(settings.theme)) theme = settings.theme;
  if (typeof settings.launchAtStartup === 'boolean') launchAtStartup = settings.launchAtStartup;
  if (typeof settings.caseSensitive === 'boolean') caseSensitive = settings.caseSensitive;
  if (typeof settings.searchFileNames === 'boolean') searchFileNames = settings.searchFileNames;
  if (isValidMaxResults(settings.maxResults)) maxResults = settings.maxResults;
  if (isValidMaxFileSize(settings.maxFileSizeMB)) maxFileSizeMB = settings.maxFileSizeMB;
  if (typeof settings.indexPaused === 'boolean') indexPaused = settings.indexPaused;
  if (Object.hasOwn(Languages, settings.language)) language = settings.language;
  // Languages whose downloaded data is gone are dropped rather than failing OCR.
  const downloaded = new Set(await downloadedOcrLanguages());
  const saveOcr = Array.isArray(settings.ocrLanguages)
    ? settings.ocrLanguages.filter((code) => BUNDLED_LANGUAGES.has(code) || downloaded.has(code))
    : [Languages[language].ocr];
  ocrLanguages = [...new Set(['eng', ...saveOcr])];
}

function saveSettings() {
  return fs.writeFile(getSettingsPath(), JSON.stringify({ indexPaths, indexExtensions, defaultExtensions: DEFAULT_EXTENSIONS, excludedFolders, hotkey, theme, launchAtStartup, caseSensitive, searchFileNames, maxResults, maxFileSizeMB, indexPaused, language, ocrLanguages }, null, 2));
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

  if (message.type === 'ocr-thumbnail-response') {
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    pendingRequests.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.thumbnail);
    return;
  }

  if (message.type === 'search-response' || message.type === 'clear-response') {
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    pendingRequests.delete(message.requestId);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      indexStatus = message.status;
      pending.resolve({ results: message.results, limitReached: message.limitReached, status: message.status });
    }
  }
}

function failPendingRequests(reason) {
  for (const { reject } of pendingRequests.values()) reject(new Error(reason));
  pendingRequests.clear();
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
      excludedFolders,
      maxFileSizeMB,
      paused: indexPaused,
      ocrLanguages,
      ocrDataDir: getOcrDataDir()
    }
  });
  indexWorker.on('message', handleWorkerMessage);
  indexWorker.on('error', (error) => {
    console.error('Index worker error:', error);
    indexStatus = { ...indexStatus, error: error.message };
    mainWindow?.webContents.send('index:status', indexStatus);
  });
  indexWorker.on('exit', (code) => {
    indexWorker = null;
    failPendingRequests(translate('__search_index_stopped__') || 'The search index stopped.');
    if (isQuitting) return;
    console.error(`Index worker exited with code ${code}; restarting.`);
    setTimeout(() => {
      if (!isQuitting && !indexWorker) startIndexWorker();
    }, WORKER_RESTART_DELAY_MS);
  });

  if (idleReporter) return;
  const reportIdle = () => {
    indexWorker?.postMessage({ type: 'idle', idle: powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SECONDS });
  }
  idleReporter = setInterval(reportIdle, 15 * 1000);
  idleReporter.unref();
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
    await loadSettings();
    nativeTheme.themeSource = theme;
    app.setLoginItemSettings({ openAtLogin: launchAtStartup, args: LOGIN_ARGS });
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
