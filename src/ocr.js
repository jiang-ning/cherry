// Text recognition (OCR) for scanned PDFs and images with Tesseract (tesseract.js, WebAssembly).
// PDF pages are rendered with PDF.js, images are decoded with @napi-rs/canvas, and TIFF with UTIF.
// Everything runs on this computer: the language data ships with the app, so nothing is downloaded.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_OCR_PAGES = 50;
// A PDF page with fewer non-space characters of text than this is treated as scanned and OCR'd.
const MIN_PAGE_TEXT_CHARS = 100;
// Longest side of a page image in pixels; larger pages are scaled down to keep OCR time reasonable.
const MAX_PAGE_DIMENSION = 4000;
// TIFF pages are decoded to full-size RGBA first, so very large ones are refused.
const MAX_TIFF_PIXELS = 100 * 1000 * 1000;
// PDF pages are rendered at 300 DPI (PDF units are 1/72 inch), which suits Tesseract.
const PDF_RENDER_SCALE = 300 / 72;
// Language data comes from the @tesseract.js-data/<language> package.
const OCR_LANGUAGE = 'eng';
const PAGE_TIMEOUT_MS = 2 * 60 * 1000;
// The Tesseract worker is closed after this long without requests to free its memory.
const IDLE_EXIT_MS = 60 * 1000;
// Thumbnail pixel size; the result list shows it at half size for high-DPI screens.
const THUMBNAIL_WIDTH = 480;
const THUMBNAIL_HEIGHT = 160;
const MAX_THUMBNAIL_UPSCALE = 2;
const MAX_CACHED_THUMBNAILS = 200;
const TIFF_EXTENSIONS = new Set(['.tif', '.tiff']);

let canvasModule;
let pdfjsPromise;
let UTIF;
let workerPromise = null;
let activeJobs = 0;
let idleTimer = null;
const thumbnailCache = new Map();

const canvas = () => (canvasModule ??= require('@napi-rs/canvas'));
const packageDir = (name) => path.dirname(require.resolve(`${name}/package.json`));

function createPageCanvas(width, height) {
  const page = canvas().createCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
  const context = page.getContext('2d');
  // Transparent areas would otherwise read as black, hiding dark text.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, page.width, page.height);
  return { page, context };
}

// Thumbnails rely on this giving the same pixel size every time a page is read.
function drawPage(source, width, height) {
  const scale = Math.min(1, MAX_PAGE_DIMENSION / Math.max(width, height, 1));
  const { page, context } = createPageCanvas(width * scale, height * scale);
  context.drawImage(source, 0, 0, page.width, page.height);
  return page;
}

async function openPdf(filePath) {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsPromise;
  const root = packageDir('pdfjs-dist');
  // PDF.js requires these folder URLs to end with "/".
  return pdfjs.getDocument({
    data: new Uint8Array(await fs.readFile(filePath)),
    cMapUrl: `${path.join(root, 'cmaps')}/`,
    standardFontDataUrl: `${path.join(root, 'standard_fonts')}/`,
    wasmUrl: `${path.join(root, 'wasm')}/`,
    isEvalSupported: false,
    verbosity: 0
  }).promise;
}

async function renderPdfPage(pdfPage) {
  const size = pdfPage.getViewport({ scale: 1 });
  const scale = Math.min(PDF_RENDER_SCALE, MAX_PAGE_DIMENSION / Math.max(size.width, size.height, 1));
  const viewport = pdfPage.getViewport({ scale });
  const { page, context } = createPageCanvas(viewport.width, viewport.height);
  await pdfPage.render({ canvasContext: context, viewport }).promise;
  return page;
}

// Scanners and scanning apps often add a little text, such as a watermark, to each scanned page.
async function hasTextLayer(pdfPage) {
  const { items } = await pdfPage.getTextContent();
  let chars = 0;
  for (const item of items) chars += (item.str ?? '').replace(/\s+/g, '').length;
  return chars >= MIN_PAGE_TEXT_CHARS;
}

function decodeTiffPage(buffer, ifds, index) {
  const ifd = ifds[index];
  const width = ifd.t256?.[0] ?? 0;
  const height = ifd.t257?.[0] ?? 0;
  if (!width || !height || width * height > MAX_TIFF_PIXELS) throw new Error('Unsupported TIFF page size.');
  UTIF.decodeImage(buffer, ifd, ifds);
  const { page, context } = createPageCanvas(ifd.width, ifd.height);
  const pixels = context.createImageData(page.width, page.height);
  pixels.data.set(UTIF.toRGBA8(ifd));
  context.putImageData(pixels, 0, 0);
  return drawPage(page, page.width, page.height);
}

// Yields { index, page } with each page as a canvas, starting at zero-based page `first`, at most
// `count` of them. With `scannedOnly`, PDF pages that have a text layer are passed over.
async function* readPages(filePath, kind, first, count, scannedOnly = false) {
  if (kind === 'pdf') {
    const document = await openPdf(filePath);
    try {
      const last = Math.min(document.numPages, first + count);
      for (let index = first; index < last; index++) {
        const pdfPage = await document.getPage(index + 1);
        try {
          if (scannedOnly && await hasTextLayer(pdfPage)) continue;
          yield { index, page: await renderPdfPage(pdfPage) };
        } finally {
          pdfPage.cleanup();
        }
      }
    } finally {
      await document.destroy();
    }
    return;
  }

  const buffer = await fs.readFile(filePath);
  if (TIFF_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    UTIF ??= require('utif');
    const ifds = UTIF.decode(buffer);
    const last = Math.min(ifds.length, first + count);
    for (let index = first; index < last; index++) yield { index, page: decodeTiffPage(buffer, ifds, index) };
    return;
  }
  if (first > 0) return;
  const image = await canvas().loadImage(buffer);
  yield { index: 0, page: drawPage(image, image.width, image.height) };
}

function getWorker() {
  workerPromise ??= (async () => {
    const { createWorker } = require('tesseract.js');
    // A local langPath and no cache keep tesseract.js from downloading or writing language data.
    return createWorker(OCR_LANGUAGE, 1, {
      langPath: path.join(packageDir(`@tesseract.js-data/${OCR_LANGUAGE}`), '4.0.0_best_int'),
      cacheMethod: 'none'
    });
  })().catch((error) => {
    workerPromise = null;
    throw error;
  });
  return workerPromise;
}

function stopWorker() {
  const pending = workerPromise;
  workerPromise = null;
  pending?.then((worker) => worker.terminate()).catch(() => {});
}

function scheduleIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopWorker, IDLE_EXIT_MS);
  idleTimer.unref?.();
}

async function recognizePage(page) {
  const worker = await getWorker();
  const image = await page.encode('png');
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      stopWorker();
      reject(new Error('OCR timed out.'));
    }, PAGE_TIMEOUT_MS);
  });
  try {
    const { data } = await Promise.race([worker.recognize(image, {}, { text: false, blocks: true }), timeout]);
    return data.blocks ?? [];
  } finally {
    clearTimeout(timer);
  }
}

// Returns { text, layout } for an image ('image') or the scanned pages of a PDF ('pdf'), where
// `layout.pages` holds each OCR'd page's pixel size by page index and `layout.words` is flat: 
// page, start, end, x, y, width, height for each word, with start and end its offsets in `text`. 
// Throws when the file can't be read.
async function recognize(filePath, kind) {
  activeJobs += 1;
  clearTimeout(idleTimer);
  try {
    const pages = [];
    const words = [];
    let text = '';
    for await (const { index: pageIndex, page } of readPages(filePath, kind, 0, MAX_OCR_PAGES, kind === 'pdf')) {
      pages[pageIndex] = [page.width, page.height];
      for (const block of await recognizePage(page)) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            for (const word of line.words) {
              const value = word.text.replace(/\s+/g, ' ').trim();
              if (!value) continue;
              const start = text ? text.length + 1 : 0;
              text = text ? `${text} ${value}` : value;
              const { x0, y0, x1, y1 } = word.bbox;
              words.push(pageIndex, start, text.length, x0, y0, x1 - x0, y1 - y0);
            }
          }
        }
      }
    }
    return { text, layout: { pages, words } };
  } finally {
    activeJobs -= 1;
    if (!activeJobs) scheduleIdleExit();
  }
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// A crop with the thumbnail's aspect ratio, centered on the match with a little context around it.
function cropAround({ pageWidth, pageHeight, box }) {
  const aspect = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
  let height = box.height * 4;
  let width = Math.max(box.width + box.height * 4, height * aspect);
  height = Math.min(Math.max(height, width / aspect), pageHeight);
  width = Math.min(width, pageWidth);
  const x = Math.round(clamp(box.x + (box.width - width) / 2, 0, pageWidth - width));
  const y = Math.round(clamp(box.y + (box.height - height) / 2, 0, pageHeight - height));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(width), pageWidth - x)),
    height: Math.max(1, Math.min(Math.round(height), pageHeight - y))
  };
}

// `region` comes from FileIndex.ocrRegion. Returns { src, mark } where `mark` places the match on the
// thumbnail in percent, or null when the page no longer matches the indexed one.
async function renderMatchThumbnail(filePath, region) {
  const key = JSON.stringify([filePath, region.modifiedMs, region.page, region.box]);
  if (thumbnailCache.has(key)) return thumbnailCache.get(key);

  const crop = cropAround(region);
  const scale = Math.min(THUMBNAIL_WIDTH / crop.width, THUMBNAIL_HEIGHT / crop.height, MAX_THUMBNAIL_UPSCALE);
  const outWidth = Math.max(1, Math.round(crop.width * scale));
  const outHeight = Math.max(1, Math.round(crop.height * scale));
  const kind = path.extname(filePath).toLowerCase() === '.pdf' ? 'pdf' : 'image';
  let source = null;
  for await (const { page } of readPages(filePath, kind, region.page, 1)) source = page;
  // A file changed since it was indexed can render at another size, so its word boxes no longer fit.
  if (!source || source.width !== region.pageWidth || source.height !== region.pageHeight) return null;
  const target = canvas().createCanvas(outWidth, outHeight);
  const context = target.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, outWidth, outHeight);
  const png = (await target.encode('png')).toString('base64');

  const percent = (value, total) => Math.round(clamp(value / total, 0, 1) * 10000) / 100;
  const { box } = region;
  const thumbnail = {
    src: `data:image/png;base64,${png}`,
    mark: {
      left: percent(box.x - crop.x, crop.width),
      top: percent(box.y - crop.y, crop.height),
      width: percent(box.width, crop.width),
      height: percent(box.height, crop.height)
    }
  };
  thumbnailCache.set(key, thumbnail);
  if (thumbnailCache.size > MAX_CACHED_THUMBNAILS) thumbnailCache.delete(thumbnailCache.keys().next().value);
  return thumbnail;
}

module.exports = { recognize, renderMatchThumbnail };
