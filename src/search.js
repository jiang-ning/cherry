const fs = require('node:fs/promises');
const path = require('node:path');

const MB = 1024 * 1024;
const DEFAULT_MAX_FILE_SIZE_MB = 50;
const MIN_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_MB = 200;
const MAX_INDEXED_CHARS = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.log', '.json', '.xml', '.html',
  '.htm', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.toml', '.properties',
  '.sql', '.js', '.ts', '.jsx', '.tsx', '.css', '.py', '.java', '.c', '.cpp',
  '.h', '.cs', '.go', '.rs', '.rb', '.sh', '.ps1', '.bat'
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.docx', '.xlsx', '.pptx', '.pdf', '.odt', '.ods', '.odp', '.rtf'
]);
const EMAIL_EXTENSIONS = new Set(['.eml', '.msg']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar', '.tar', '.tgz', '.gz']);
// Read with Windows OCR, so they are only indexed by default on Windows.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff']);
const OCR_SUPPORTED = process.platform === 'win32';
// A PDF whose text layer has fewer non-space characters than this is treated as scanned and OCR'd.
const SCANNED_PDF_MIN_CHARS = 100;
// How many levels of attachments and archive entries are opened, e.g. a ZIP inside an email.
const MAX_NESTING_DEPTH = 3;
const DEFAULT_EXCLUDED_FOLDERS = [
  '$Recycle.Bin', 'System Volume Information', '.git', '.svn', 'node_modules'
];

let officeParser;
let containers;
let ocr;
const DEFAULT_EXTENSIONS = [
  ...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS, ...EMAIL_EXTENSIONS, ...ARCHIVE_EXTENSIONS,
  ...(OCR_SUPPORTED ? IMAGE_EXTENSIONS : [])
];
// The defaults before email and archive support, used to add the new defaults to saved settings.
const LEGACY_DEFAULT_EXTENSIONS = [...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS];

function isSupportedFile(name, extensions) {
  // Office writes "~$name.docx" lock files while a docment is open.
  if (name.startsWith('~$')) return false;
  return extensions.has(path.extname(name).toLowerCase());
}

// `excluded` holds lowercase folder names.
function isIgnoredDirectory(name, excluded) {
  return excluded.has(name.toLowerCase());
}

// `source` is a file path, or a Buffer together with its `fileType` such as 'docx'.
async function readDocumentText(source, fileType = null) {
  officeParser ??= require('officeparser');
  const document = await officeParser.parseOffice(source, {
    fileType,
    extractAttachments: false,
    ocr: false,
    pdfParserConfig: { extractTextColor: false }
  });
  const { value } = await document.to('text', {
    includeImages: false,
    textConfig: { preserveLayout: false }
  });
  return String(value ?? '');
}

// Returns { text, layout } from OCR, or null when Windows OCR isn't available.
function recognize(filePath, kind) {
  if (!OCR_SUPPORTED) return Promise.resolve(null);
  ocr ??= require('./ocr');
  return ocr.recognize(filePath, kind);
}

// Uses the PDF's text layer, and OCR when there is little or no text layer (a scanned PDF).
async function readPdfText(filePath) {
  let text = '';
  let parseError = null;
  try {
    text = await readDocumentText(filePath);
  } catch (error) {
    parseError = error;
  }
  if (text.replace(/\s+/g, '').length >= SCANNED_PDF_MIN_CHARS) return { text, recognized: null };

  let recognized = null;
  try {
    recognized = await recognize(filePath, 'pdf');
  } catch {
    // Keep whatever the text layer had.
  }
  if (recognized === null && parseError) throw parseError;
  return { text, recognized };
}

async function readBufferText(name, buffer, context) {
  const extension = path.extname(name).toLowerCase();
  // OCR needs a file on disk, so images inside emails and archives aren't read.
  if (IMAGE_EXTENSIONS.has(extension)) return null;
  if (DOCUMENT_EXTENSIONS.has(extension)) return readDocumentText(buffer, extension.slice(1));
  if (EMAIL_EXTENSIONS.has(extension) || ARCHIVE_EXTENSIONS.has(extension)) {
    containers ??= require('./containers');
    const readNested = (nestedName, bytes) => readNestedText(nestedName, bytes, context);
    const isSupported = (entryName) => isSupportedFile(entryName, context.extensions);
    if (extension === '.eml') return containers.readEmlText(buffer, context, readNested);
    if (extension === '.msg') return containers.readMsgText(buffer, context, readNested);
    if (extension === '.zip') return containers.readZipText(buffer, context, readNested, isSupported);
    if (extension === '.gz') return containers.readGzipText(name, buffer, context, readNested, isSupported);
    return containers.readArchiveText(buffer, context, readNested, isSupported);
  }
  // User-added extensions are read as plain text; binary files are rejected.
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

// Reads an email attachment or archive entry. Failures skip just that item.
async function readNestedText(name, bytes, context) {
  if (context.depth >= MAX_NESTING_DEPTH) return null;
  if (!isSupportedFile(path.basename(name), context.extensions)) return null;
  if (!bytes.byteLength || bytes.byteLength > context.maxBytes) return null;
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = await readBufferText(name, buffer, { ...context, depth: context.depth + 1 });
    return text?.replace(/^\uFEFF/, '') || null;
  } catch {
    return null;
  }
}

// Returns { text, layout }, or null when the file is empty, too large, binary, or unsupported.
// `layout` holds the page positions of OCR'd words (see ocr.js), with `offset` added for where
// the OCR text starts in `text`; it is null for files that weren't OCR'd.
// `extensions` decides which attachments and archive entries are read.
async function extractText(filePath, size, maxFileSizeMB = DEFAULT_MAX_FILE_SIZE_MB, extensions = DEFAULT_EXTENSIONS) {
  if (size === 0 || size > maxFileSizeMB * MB) return null;
  const extension = path.extname(filePath).toLowerCase();
  let raw;
  let recognized = null;

  if (extension === '.pdf') {
    ({ text: raw, recognized } = await readPdfText(filePath));
  } else if (DOCUMENT_EXTENSIONS.has(extension)) {
    raw = await readDocumentText(filePath);
  } else if (IMAGE_EXTENSIONS.has(extension)) {
    recognized = await recognize(filePath, 'image');
    if (recognized === null) return null;
    raw = '';
  } else {
    const context = {
      extensions: new Set(extensions),
      maxBytes: maxFileSizeMB * MB,
      maxChars: MAX_INDEXED_CHARS,
      maxDepth: MAX_NESTING_DEPTH,
      depth: 0,
      readHtml: (html) => readDocumentText(Buffer.from(html), 'html')
    };
    raw = await readBufferText(filePath, await fs.readFile(filePath), context);
    if (raw === null) return null;
  }

  const text = raw.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim();
  let layout = null;
  // OCR text is already whitespace-normalized, so word offsets stay valid after the join.
  if (recognized?.text) {
    const offset = text ? text.length + 1 : 0;
    text = text ? `${text} ${recognized.text}` : recognized.text;
    layout = { offset, ...recognized.layout };
  }
  text = text.slice(0, MAX_INDEXED_CHARS);
  return text ? { text, layout } : null;
}

function parseSearchQuery(rawQuery) {
  const normalized = rawQuery.replace(/\s+/g, ' ').trim();
  const wholeWord = normalized.startsWith('"') && normalized.endsWith('"');
  const query = wholeWord ? normalized.slice(1, -1).trim() : normalized;
  return { query, wholeWord };
}

function parseBooleanQuery(rawQuery) {
  const tokens = rawQuery.match(/"[^"]*"|\S+/g) ?? [];
  const sequence = [];
  let termTokens = [];
  let hasOperator = false;

  const pushTerm = () => {
    if (!termTokens.length) return false;
    const rawTerm = termTokens.join(' ');
    const { query, wholeWord } = parseSearchQuery(rawTerm);
    if (!query) return false;
    sequence.push({ type: 'term', query, wholeWord });
    termTokens = [];
    return true;
  };

  for (const token of tokens) {
    if (token === 'AND' || token === 'OR' || token === 'NOT') {
      hasOperator = true;
      if (token === 'NOT' && sequence.at(-1) === 'AND' && !termTokens.length) {
        sequence.push(token);
        continue;
      }
      if (!pushTerm()) return { invalid: true };
      sequence.push(token);
    } else {
      termTokens.push(token);
    }
  }
  if (termTokens.length && !pushTerm()) return { invalid: true };
  if (!hasOperator) return null;
  if (sequence.at(-1)?.type !== 'term') return { invalid: true };

  let position = 0;
  const parseTerm = () => {
    const term = sequence[position];
    if (term?.type !== 'term') throw new Error('Invalid boolean query');
    position += 1;
    return term;
  };
  const parseAnd = () => {
    let node = parseTerm();
    while (sequence[position] === 'AND' || sequence[position] === 'NOT') {
      const operator = sequence[position++];
      const excludeNext = operator === 'NOT' || (operator === 'AND' && sequence[position] === 'NOT');
      if (operator === 'AND' && sequence[position] === 'NOT') position += 1;
      const right = parseTerm();
      node = { type: excludeNext ? 'andNot' : 'and', left: node, right };
    }
    return node;
  };
  const parseOr = () => {
    let node = parseAnd();
    while (sequence[position] === 'OR') {
      position += 1;
      node = { type: 'or', left: node, right: parseAnd() };
    }
    return node;
  };

  try {
    const expression = parseOr();
    return position === sequence.length ? { expression } : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

function findHighlights(text, query, wholeWord = false, caseSensitive = false) {
  const flags = caseSensitive ? 'gu' : 'giu';
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = wholeWord
    ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapedQuery}(?![\\p{L}\\p{N}_])`, flags)
    : new RegExp(escapedQuery, flags);
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, length: match[0].length }));
}

module.exports = {
  DEFAULT_EXCLUDED_FOLDERS,
  DEFAULT_EXTENSIONS,
  DEFAULT_MAX_FILE_SIZE_MB,
  IMAGE_EXTENSIONS,
  LEGACY_DEFAULT_EXTENSIONS,
  OCR_SUPPORTED,
  SCANNED_PDF_MIN_CHARS,
  MIN_FILE_SIZE_MB,
  MAX_FILE_SIZE_MB,
  MB,
  extractText,
  findHighlights,
  isSupportedFile,
  isIgnoredDirectory,
  parseBooleanQuery,
  parseSearchQuery
};
