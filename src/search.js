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
const DEFAULT_EXCLUDED_FOLDERS = [
  '$Recycle.Bin', 'System Volume Information', '.git', '.svn', 'node_modules'
];

let officeParser;
const DEFAULT_EXTENSIONS = [...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS];

function isSupportedFile(name, extensions) {
  // Office writes "~$name.docx" lock files while a docment is open.
  if (name.startsWith('~$')) return false;
  return extensions.has(path.extname(name).toLowerCase());
}

// `excluded` holds lowercase folder names.
function isIgnoredDirectory(name, excluded) {
  return excluded.has(name.toLowerCase());
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
  } else {
    // User-added extensions are read as plain text; binary files are rejected below.
    if (size > MAX_FILE_BYTES) return null;
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) return null;
    raw = buffer.toString('utf8');
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

function findHighlights(text, query, wholeWord = false) {
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = wholeWord
    ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapedQuery}(?![\\p{L}\\p{N}_])`, 'giu')
    : new RegExp(escapedQuery, 'giu');
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, length: match[0].length }));
}

module.exports = {
  DEFAULT_EXCLUDED_FOLDERS,
  DEFAULT_EXTENSIONS,
  extractText,
  findHighlights,
  isSupportedFile,
  isIgnoredDirectory,
  parseBooleanQuery,
  parseSearchQuery
};
