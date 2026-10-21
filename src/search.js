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
// How many levels of attachments and archive entries are opened, e.g. a ZIP inside an email.
const MAX_NESTING_DEPTH = 3;
const DEFAULT_EXCLUDED_FOLDERS = [
  '$Recycle.Bin', 'System Volume Information', '.git', '.svn', 'node_modules'
];

let officeParser;
let containers;
const DEFAULT_EXTENSIONS = [...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS, ...EMAIL_EXTENSIONS, ...ARCHIVE_EXTENSIONS];
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

async function readBufferText(name, buffer, context) {
  const extension = path.extname(name).toLowerCase();
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

// Returns searchable text, or null when the file is empty, too large, binary, or unsupported.
// `extensions` decides which attachments and archive entries are read.
async function extractText(filePath, size, maxFileSizeMB = DEFAULT_MAX_FILE_SIZE_MB, extensions = DEFAULT_EXTENSIONS) {
  if (size === 0 || size > maxFileSizeMB * MB) return null;
  const extension = path.extname(filePath).toLowerCase();
  let raw;

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    raw = await readDocumentText(filePath);
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

  const text = raw.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_INDEXED_CHARS);
  return text || null;
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
  LEGACY_DEFAULT_EXTENSIONS,
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
