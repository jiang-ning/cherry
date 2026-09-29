const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
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
const IGNORED_DIRECTORIES = new Set([
  '$recycle.bin', 'system volume information', '.git', '.svn', 'node_modules'
]);

let officeParser;

function isSupportedFile(name) {
  // Office writes "~$name.docx" lock files while a docment is open.
  if (name.startsWith('~$')) return false;
  const extension = path.extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || DOCUMENT_EXTENSIONS.has(extension);
}

function isIgnoredDirectory(name) {
  return IGNORED_DIRECTORIES.has(name.toLowerCase());
}

async function readDocumentText(filePath) {
  officeParser ??= require('officeparser');
  const document = await officeParser.parseOffice(filePath, {
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

// Returns searchable text, or null when the file is empty, too large, binary, or unsupported.
async function extractText(filePath, size) {
  if (size === 0) return null;
  const extension = path.extname(filePath).toLowerCase();
  let raw;

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    if (size > MAX_DOCUMENT_BYTES) return null;
    raw = await readDocumentText(filePath);
  } else if (TEXT_EXTENSIONS.has(extension)) {
    if (size > MAX_FILE_BYTES) return null;
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) return null;
    raw = buffer.toString('utf8');
  } else {
    return null;
  }

  const text = raw.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_INDEXED_CHARS);
  return text || null;
}

function findHighlights(text, query) {
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, length: match[0].length }));
}

module.exports = { extractText, findHighlights, isSupportedFile, isIgnoredDirectory };
