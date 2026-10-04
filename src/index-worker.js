const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FileIndex } = require('./file-index');
const { extractText, isSupportedFile, isIgnoredDirectory } = require('./search');

const RESCAN_INTERVAL_MS = 10 * 60 * 1000;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_INTERVAL_MS = 1000;
const WAIT_MS = 2000;

const index = new FileIndex(workerData.databasePath);
let roots = workerData.roots;
let rescanRequested = false;
let wakeScan = null;
let idle = false;
// Until the first full index exists, index everything right away instead of waiting for idle time.
let initialIndexing = !index.isInitialIndexDone();
let scanCompleted = false;
let scanning = false;
let lastError = null;
let lastStatusAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// setTimeout has ~15ms resolution on Windows, so zero-length pauses yield with setImmediate instead.
const pause = (ms) => (ms ? sleep(ms) : new Promise((resolve) => setImmediate(resolve)));

function currentStatus() {
  return { ...index.stats(), scanning, idle, initialIndexing, error: lastError };
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

  if (isDirectory) return isIgnoredDirectory(entry.name) ? null : { directory: entryPath };
  if (!isFile || !isSupportedFile(entry.name)) return null;
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
  const queue = [...roots];
  let rootsReadable = true;

  while (queue.length) {
    const directory = queue.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      if (roots.includes(directory)) rootsReadable = false;
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
    await pause(idle || initialIndexing ? 0 : 5);
  }

  // An unreadable root would otherwise look like every file was deleted.
  if (rootsReadable) {
    index.finishScan(scanId);
    scanCompleted = true;
  }
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
    rescanRequested = false;
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
    try {
      const file = index.nextPending();
      if (!file && initialIndexing && scanCompleted) {
        index.markInitialIndexDone();
        initialIndexing = false;
        postStatus(true);
      }
      const eager = idle || initialIndexing;
      const isRecent = file && file.modifiedMs >= Date.now() - RECENT_WINDOW_MS;
      // Pending files come newest first, so an old one at the top means only old files remain.
      if (!file || (!isRecent && !eager)) {
        await sleep(WAIT_MS);
        continue;
      }

      try {
        const text = await extractText(file.path, file.size);
        if (text === null) index.markSkipped(file.id);
        else index.saveContent(file, text);
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

parentPort.on('message', (message) => {
  if (message.type === 'idle') {
    const wasIdle = idle;
    idle = Boolean(message.idle);
    if (idle !== wasIdle) postStatus(true);
    return;
  }

  if (message.type === 'set-roots') {
    roots = message.roots;
    rescanRequested = true;
    wakeScan?.();
    return;
  }

  if (message.type === 'search') {
    try {
      const { results, limitReached } = index.search(message.query);
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

scanLoop();
indexLoop();
