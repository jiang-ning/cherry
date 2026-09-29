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
const roots = workerData.roots;
let idle = false;
let scanning = false;
let lastError = null;
let lastStatusAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function currentStatus() {
  return { ...index.stats(), scanning, idle, root: roots[0], error: lastError };
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

    const files = [];
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      // Dirent reports symlinks and junctions as neither directory nor file, so they are not followed.
      if (entry.isDirectory()) {
        if (!isIgnoredDirectory(entry.name)) queue.push(entryPath);
      } else if (entry.isFile() && isSupportedFile(entry.name)) {
        try {
          const stats = await fs.stat(entryPath);
          files.push({ path: entryPath, modifiedMs: stats.mtimeMs, size: stats.size });
        } catch {
          // Locked or vanished files are picked up on the next scan.
        }
      }
    }

    index.recordFiles(files, scanId);
    postStatus();
    await sleep(idle ? 0 : 5);
  }

  // An unreadable root would otherwise look like every file was deleted.
  if (rootsReadable) index.finishScan(scanId);
  scanning = false;
  postStatus(true);
}

async function scanLoop() {
  for (;;) {
    try {
      await scan();
      lastError = null;
    } catch (error) {
      scanning = false;
      lastError = error.message;
      postStatus(true);
    }
    await sleep(RESCAN_INTERVAL_MS);
  }
}

async function indexLoop() {
  for (;;) {
    try {
      const file = index.nextPending();
      const isRecent = file && file.modifiedMs >= Date.now() - RECENT_WINDOW_MS;
      // Pending files come newest first, so an old one at the top means only old files remain.
      if (!file || (!isRecent && !idle)) {
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
      await sleep(idle ? 10 : 200);
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
