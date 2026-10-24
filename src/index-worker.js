const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FileIndex } = require('./file-index');
const {
  MB, IMAGE_EXTENSIONS, OCR_SUPPORTED, SCANNED_PDF_MIN_CHARS, extractText, isSupportedFile, isIgnoredDirectory
} = require('./search');

const RESCAN_INTERVAL_MS = 10 * 60 * 1000;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_INTERVAL_MS = 1000;
const WAIT_MS = 2000;

const index = new FileIndex(workerData.databasePath);
let roots = workerData.roots;
let extensions = new Set(workerData.extensions);
let excludedFolders = new Set(workerData.excludedFolders.map((name) => name.toLowerCase()));
let maxFileSizeMB = workerData.maxFileSizeMB;
index.applyMaxFileSize(maxFileSizeMB * MB);
if (OCR_SUPPORTED) index.requeueForOcr(['.pdf', ...IMAGE_EXTENSIONS], SCANNED_PDF_MIN_CHARS);
let rescanRequested = false;
let wakeScan = null;
let idle = false;
// Until the first full index exists, index everything right away instead of waiting for idle time.
let initialIndexing = !index.isInitialIndexDone();
let scanCompleted = false;
let scanning = false;
// Set when settings change: index everything now instead of waiting for idle.
let catchUp = false;
let lastError = null;
let lastStatusAt = 0;
// User-requested pause: scanning and content extraction stop, searching keeps working.
let paused = Boolean(workerData.paused);
let resumeWaiters = [];
// Set by a clear so an in-flight scan stops instead of recording files against the wiped index.
let abortScan = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// setTimeout has ~15ms resolution on Windows, so zero-length pauses yield with setImmediate instead.
const pause = (ms) => (ms ? sleep(ms) : new Promise((resolve) => setImmediate(resolve)));

async function waitWhilePaused() {
  while (paused) await new Promise((resolve) => resumeWaiters.push(resolve));
}

function setPaused(value) {
  paused = value;
  if (!paused) resumeWaiters.splice(0).forEach((resolve) => resolve());
  postStatus(true);
}

function currentStatus() {
  return { ...index.stats(), scanning, idle, initialIndexing, paused, error: lastError };
}

// Returns { directory } or { file } for entries worth visiting, otherwise null.
async function describeEntry(directory, entry) {
  const entryPath = path.join(directory, entry.name);
  let isDirectory = entry.isDirectory();
  let isFile = entry.isFile();
  let stats;

  // Windows reports every reparse point as a link, including OneDrive/cloud-synced files and folders.
  // lstat still reports real symlinks and junctions as links, so those stay unfollowed.
  if (entry.isSymbolicLink() && process.platform === 'win32') {
    try {
      stats = await fs.lstat(entryPath);
    } catch {
      return null;
    }
    isDirectory = stats.isDirectory();
    isFile = stats.isFile();
  }

  if (isDirectory) return isIgnoredDirectory(entry.name, excludedFolders) ? null : { directory: entryPath };
  if (!isFile || !isSupportedFile(entry.name, extensions)) return null;
  try {
    stats ??= await fs.stat(entryPath);
    return { file: { path: entryPath, modifiedMs: stats.mtimeMs, size: stats.size } };
  } catch {
    // Locked or vanished files are picked up on the next scan.
    return null;
  }
}

function postStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastStatusAt < STATUS_INTERVAL_MS) return;
  lastStatusAt = now;
  parentPort.postMessage({ type: 'status', status: currentStatus() });
}

async function scan() {
  scanning = true;
  postStatus(true);
  const scanId = index.beginScan();
  const scanRoots = [...roots];
  const queue = [...scanRoots];
  const unreadableRoots = [];

  while (queue.length) {
    await waitWhilePaused();
    if (abortScan) break;
    const directory = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      if (scanRoots.includes(directory)) unreadableRoots.push(directory);
      continue;
    }

    const described = await Promise.all(entries.map((entry) => describeEntry(directory, entry)));

    const files = [];
    for (const item of described) {
      if (item?.directory) queue.push(item.directory);
      else if (item?.file) files.push(item.file);
    }

    index.recordFiles(files, scanId);
    postStatus();
    await pause(idle || initialIndexing || catchUp ? 0 : 5);
  }

  if (abortScan) {
    abortScan = false;
    scanning = false;
    postStatus(true);
    return;
  }

  // An unreadable root (e.g. unplugged drive) would otherwise look like all its files were deleted.
  for (const root of unreadableRoots) index.keepFilesUnder(root, scanId);
  index.finishScan(scanId);
  scanCompleted = true;
  scanning = false;
  postStatus(true);
}

function waitForRescan() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RESCAN_INTERVAL_MS);
    wakeScan = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function scanLoop() {
  for (;;) {
    await waitWhilePaused();
    rescanRequested = false;
    abortScan = false;
    try {
      await scan();
      lastError = null;
    } catch (error) {
      scanning = false;
      lastError = error.message;
      postStatus(true);
    }
    // Roots changed mid-scan: scan again right away so removed folders get purged.
    if (!rescanRequested) await waitForRescan();
    wakeScan = null;
  }
}

async function indexLoop() {
  for (;;) {
    await waitWhilePaused();
    try {
      const file = index.nextPending();
      if (!file && initialIndexing && scanCompleted) {
        index.markInitialIndexDone();
        initialIndexing = false;
        postStatus(true);
      }
      if (!file && catchUp && !scanning) catchUp = false;
      const eager = idle || initialIndexing || catchUp;
      const isRecent = file && file.modifiedMs >= Date.now() - RECENT_WINDOW_MS;
      // Pending files come newest first, so an old one at the top means only old files remain.
      if (!file || (!isRecent && !eager)) {
        await sleep(WAIT_MS);
        continue;
      }

      try {
        const extracted = await extractText(file.path, file.size, maxFileSizeMB, extensions);
        if (extracted === null) index.markSkipped(file.id);
        else index.saveContent(file, extracted.text, extracted.layout);
      } catch {
        index.markSkipped(file.id);
      }
      postStatus();
      await pause(eager ? 0 : 200);
    } catch (error) {
      lastError = error.message;
      postStatus(true);
      await sleep(WAIT_MS);
    }
  }
}

function requestCatchUp() {
  catchUp = true;
  rescanRequested = true;
  wakeScan?.();
}

parentPort.on('message', (message) => {
  if (message.type === 'idle') {
    const wasIdle = idle;
    idle = Boolean(message.idle);
    if (idle !== wasIdle) postStatus(true);
    return;
  }

  if (message.type === 'set-roots') {
    roots = message.roots;
    requestCatchUp();
    return;
  }

  if (message.type === 'set-extensions') {
    extensions = new Set(message.extensions);
    requestCatchUp();
    return;
  }

  if (message.type === 'set-excluded-folders') {
    excludedFolders = new Set(message.excludedFolders.map((name) => name.toLowerCase()));
    requestCatchUp();
    return;
  }

  if (message.type === 'set-max-file-size') {
    maxFileSizeMB = message.maxFileSizeMB;
    index.applyMaxFileSize(maxFileSizeMB * MB);
    catchUp = true;
    postStatus(true);
    return;
  }

  if (message.type === 'set-paused') {
    setPaused(Boolean(message.paused));
    return;
  }

  if (message.type === 'clear') {
    try {
      index.clear();
      lastError = null;
      initialIndexing = true;
      scanCompleted = false;
      catchUp = false;
      if (scanning) abortScan = true;
      rescanRequested = true;
      wakeScan?.();
      parentPort.postMessage({ type: 'clear-response', requestId: message.requestId, status: currentStatus() });
    } catch (error) {
      parentPort.postMessage({ type: 'clear-response', requestId: message.requestId, error: error.message });
    }
    postStatus(true);
    return;
  }

  if (message.type === 'ocr-region') {
    try {
      const region = index.ocrRegion(message.filePath, message.start, message.length);
      parentPort.postMessage({ type: 'ocr-region-response', requestId: message.requestId, region });
    } catch (error) {
      parentPort.postMessage({ type: 'ocr-region-response', requestId: message.requestId, error: error.message });
    }
    return;
  }

  if (message.type === 'search') {
    try {
      index.maxResults = message.maxResults;
      const { results, limitReached } = index.search(message.query, message.caseSensitive === true, message.searchFileNames === true);
      parentPort.postMessage({
        type: 'search-response',
        requestId: message.requestId,
        results,
        limitReached,
        status: currentStatus()
      });
    } catch (error) {
      parentPort.postMessage({ type: 'search-response', requestId: message.requestId, error: error.message });
    }
  }
});

// A worker that starts paused never scans, so report the current state right away.
postStatus(true);
scanLoop();
indexLoop();
