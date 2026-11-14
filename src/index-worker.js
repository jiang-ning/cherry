const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FileIndex } = require('./file-index');
const ocr = require('./ocr');
const semantic = require('./semantic');
const {
  MB, IMAGE_EXTENSIONS, extractText, isSupportedFile, isIgnoredDirectory, renderPreview
} = require('./search');

const RESCAN_INTERVAL_MS = 10 * 60 * 1000;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_INTERVAL_MS = 1000;
const WAIT_MS = 2000;
// Bump when OCR changes, so files read with the old OCR, or skipped by it, are read again.
const OCR_ENGINE = 'tesseract.js-2';
// PDFs with less text than this may hold scanned pages that weren't OCR'd before.
const OCR_REQUEUE_MAX_CHARS = 2000;

const index = new FileIndex(workerData.databasePath);
let roots = workerData.roots;
let extensions = new Set(workerData.extensions);
let excludedFolders = new Set(workerData.excludedFolders.map((name) => name.toLowerCase()));
let maxFileSizeMB = workerData.maxFileSizeMB;
index.applyMaxFileSize(maxFileSizeMB * MB);
applyOcrLanguages(workerData.ocrLanguages);
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
// AI Mode: 'off' until the main process hands over a downloaded model, then 'loading', 'ready' or 'error'.
let aiState = 'off';
let aiError = null;
// Bumped on every model change, so work started with an older model is dropped.
let aiGeneration = 0;
// Set when the model loads: embed the whole backlog right away instead of waiting for idle time.
let aiCatchUp = false;
// Common words that would otherwise be highlighted all over AI Mode previews.
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'about', 'that', 'this', 'from', 'files', 'documents']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// setTimeout has ~15ms resolution on Windows, so zero-length pauses yield with setImmediate instead.
const pause = (ms) => (ms ? sleep(ms) : new Promise((resolve) => setImmediate(resolve)));

// The OCR languages are part of the engine key, so changing them re-reads scanned files once.
// `list` is checked by the main process, which also downloads the data of non-bundled languages.
function applyOcrLanguages(list) {
  ocr.configure(list, workerData.ocrDataDir);
  const codes = Array.isArray(list) ? list.filter((code) => typeof code === 'string' && code !== 'eng') : [];
  const languages = ['eng', ...codes].join('+');
  index.requeueForOcr(`${OCR_ENGINE}:${languages}`, ['.pdf', ...IMAGE_EXTENSIONS], OCR_REQUEUE_MAX_CHARS);
}

async function waitWhilePaused() {
  while (paused) await new Promise((resolve) => resumeWaiters.push(resolve));
}

function setPaused(value) {
  paused = value;
  if (!paused) resumeWaiters.splice(0).forEach((resolve) => resolve());
  postStatus(true);
}

function currentStatus() {
  const ai = { state: aiState, error: aiError, ...(aiState === 'ready' ? index.embeddingStats() : {}) };
  return { ...index.stats(), scanning, idle, initialIndexing, paused, error: lastError, ai };
}

// `modelDir` is null to turn AI Mode off.
async function setAiModel(modelDir) {
  const generation = ++aiGeneration;
  aiState = modelDir ? 'loading' : 'off';
  aiError = null;
  postStatus(true);
  try {
    if (!modelDir) {
      await semantic.unloadModel();
      return;
    }
    await semantic.loadModel(modelDir);
    if (generation !== aiGeneration) {
      if (aiState === 'off') await semantic.unloadModel();
      return;
    }
    index.useEmbeddingModel(semantic.MODEL_ID);
    aiState = 'ready';
    aiCatchUp = true;
  } catch (error) {
    if (generation !== aiGeneration) return;
    aiState = 'error';
    aiError = error.message;
  }
  postStatus(true);
}

async function searchByMeaning(query) {
  if (aiState !== 'ready') throw new Error('AI Mode is not ready.');
  const { topic, from, to } = semantic.parseTimeQuery(query);
  const vector = topic ? await semantic.embedQuery(topic) : null;
  const terms = topic.split(' ').filter((word) => [...word].length >= 3 && !STOP_WORDS.has(word.toLowerCase()));
  return index.searchSemantic(vector, from, to, terms);
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

// Embeds indexed files for AI Mode, newest first, on the same schedule as content extraction.
async function embedLoop() {
  for (;;) {
    await waitWhilePaused();
    try {
      const file = aiState === 'ready' ? index.nextToEmbed() : null;
      if (!file && aiCatchUp && aiState === 'ready') {
        aiCatchUp = false;
        postStatus(true);
      }
      const eager = idle || initialIndexing || aiCatchUp;
      const isRecent = file && file.modifiedMs >= Date.now() - RECENT_WINDOW_MS;
      if (!file || (!isRecent && !eager)) {
        await sleep(WAIT_MS);
        continue;
      }

      const generation = aiGeneration;
      let chunks = [];
      try {
        chunks = await semantic.embedPassages(path.basename(file.path), file.content);
      } catch {
        // A file the model can't read is recorded without vectors so it isn't retried.
      }
      if (generation !== aiGeneration) continue;
      index.saveEmbeddings(file, chunks);
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

  if (message.type === 'set-ocr-languages') {
    applyOcrLanguages(message.languages);
    catchUp = true;
    postStatus(true);
    return;
  }

  if (message.type === 'set-paused') {
    setPaused(Boolean(message.paused));
    return;
  }

  if (message.type === 'set-ai-model') {
    setAiModel(message.modelDir).finally(() => {
      parentPort.postMessage({ type: 'ai-model-response', requestId: message.requestId });
    });
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

  if (message.type === 'ocr-thumbnail') {
    const reply = (fields) => parentPort.postMessage({
      type: 'ocr-thumbnail-response', requestId: message.requestId, ...fields
    });
    (async () => {
      const region = index.ocrRegion(message.filePath, message.start, message.length);
      if (!region) return null;
      return ocr.renderMatchThumbnail(message.filePath, region);
    })().then(
      (thumbnail) => reply({ thumbnail }),
      (error) => reply({ error: String(error?.message ?? error) })
    );
    return;
  }

  if (message.type === 'file-content') {
    const reply = (fields) => parentPort.postMessage({
      type: 'file-content-response', requestId: message.requestId, ...fields
    });
    let preview;
    try {
      preview = index.fileContent(message.filePath);
    } catch (error) {
      reply({ error: error.message });
      return;
    }
    // Only indexed files are rendered; a file that fails to render still shows its indexed text.
    if (!preview) return reply({ preview: null });
    renderPreview(message.filePath).then(
      (rendered) => reply({ preview: { ...preview, ...rendered } }),
      () => reply({ preview })
    );
    return;
  }

  if (message.type === 'search' && message.ai) {
    const reply = (fields) => parentPort.postMessage({
      type: 'search-response', requestId: message.requestId, ...fields
    });
    index.maxResults = message.maxResults;
    searchByMeaning(message.query).then(
      ({ results, limitReached }) => reply({ results, limitReached, status: currentStatus() }),
      (error) => reply({ error: error.message })
    );
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
embedLoop();
if (workerData.aiModelDir) setAiModel(workerData.aiModelDir);
