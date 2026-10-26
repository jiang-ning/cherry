const path = require('node:path');
const Database = require('better-sqlite3');
const { findHighlights, parseBooleanQuery, parseSearchQuery } = require('./search');

const MAX_RESULTS = 500;
const PREVIEW_BEFORE = 80;
const PREVIEW_LENGTH = 240;
const MIN_TRIGRAM_QUERY_LENGTH = 3;

const STATE_PENDING = 0;
const STATE_INDEXED = 1;
const STATE_SKIPPED = 2;

// Wraps the FTS query so both search paths return a small preview window instead of full file text.
const previewSelect = (innerQuery) => `
  SELECT id, path, modifiedMs, textLength, matchCount, content, hasOcr,
    max(1, position - @before) AS windowStart,
    substr(content, max(1, position - @before), length(@query) + @previewLength) AS window
  FROM (${innerQuery})
  ORDER BY modifiedMs DESC
`;

const DELETE_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
`;

const matchColumns = `
  f.id, f.path, f.modified_ms AS modifiedMs, f.content, length(f.content) AS textLength,
  EXISTS(SELECT 1 FROM ocr_layouts o WHERE o.file_id = f.id) AS hasOcr,
  instr(lower(f.content), lower(@query)) AS position,
  (length(lower(f.content)) - length(replace(lower(f.content), lower(@query), ''))) / length(@query) AS matchCount
`;

class FileIndex {
  constructor(databasePath) {
    this.db = new Database(databasePath);
    this.maxResults = MAX_RESULTS;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        modified_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        seen_scan INTEGER NOT NULL DEFAULT 0,
        state INTEGER NOT NULL DEFAULT ${STATE_PENDING},
        content TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS files_by_state ON files(state, modified_ms DESC);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Page positions of OCR'd words, used for result thumbnails. See extractText in search.js
      CREATE TABLE IF NOT EXISTS ocr_layouts (file_id INTEGER PRIMARY KEY, layout TEXT NOT NULL);

      -- Trigram tokens give case-insensitive substring matching, including for CJK text.
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        content, content='files', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, content) VALUES (new.id, new.content);
      END;
      ${DELETE_TRIGGER}
      CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO files_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);

    const recordFile = this.db.prepare(`
      INSERT INTO files(path, modified_ms, size, seen_scan)
      VALUES (@path, @modifiedMs, @size, @scanId)
      ON CONFLICT(path) DO UPDATE SET
        seen_scan = excluded.seen_scan,
        state = CASE
          WHEN files.modified_ms = excluded.modified_ms AND files.size = excluded.size THEN files.state
          ELSE ${STATE_PENDING}
        END,
        modified_ms = excluded.modified_ms,
        size = excluded.size
    `);
    this.recordFiles = this.db.transaction((files, scanId) => {
      for (const file of files) recordFile.run({ ...file, scanId });
    });

    this.initialIndexDoneStatement = this.db.prepare("SELECT 1 FROM meta WHERE key = 'initial_index_done'");
    this.markInitialIndexDoneStatement = this.db.prepare(
      "INSERT OR REPLACE INTO meta(key, value) VALUES ('initial_index_done', '1')"
    );
    this.removeUnseenStatement = this.db.prepare('DELETE FROM files WHERE seen_scan < ?');
    this.keepFilesUnderStatement = this.db.prepare(
      'UPDATE files SET seen_scan = @scanId WHERE substr(path, 1, length(@prefix)) = @prefix'
    );
    this.nextPendingStatement = this.db.prepare(`
      SELECT id, path, modified_ms AS modifiedMs, size
      FROM files WHERE state = ${STATE_PENDING}
      ORDER BY modified_ms DESC LIMIT 1
    `);
    this.saveContentStatement = this.db.prepare(`
      UPDATE files SET content = @content, state = ${STATE_INDEXED}
      WHERE id = @id AND modified_ms = @modifiedMs AND size = @size
    `);
    this.markSkippedStatement = this.db.prepare(
      `UPDATE files SET content = '', state = ${STATE_SKIPPED} WHERE id = ?`
    );
    this.saveLayoutStatement = this.db.prepare(
      'INSERT OR REPLACE INTO ocr_layouts(file_id, layout) VALUES (?, ?)'
    );
    this.deleteLayoutStatement = this.db.prepare('DELETE FROM ocr_layouts WHERE file_id = ?');
    this.removeOrphanLayoutsStatement = this.db.prepare(
      'DELETE FROM ocr_layouts WHERE file_id NOT IN (SELECT id FROM files)'
    );
    this.layoutStatement = this.db.prepare(`
      SELECT f.modified_ms AS modifiedMs, f.content, o.layout
      FROM files f JOIN ocr_layouts o ON o.file_id = f.id
      WHERE f.path = ? AND f.state = ${STATE_INDEXED}
    `);
    this.requeueSkippedStatement = this.db.prepare(
      `UPDATE files SET state = ${STATE_PENDING} WHERE state = ${STATE_SKIPPED} AND size > @oldBytes AND size <= @newBytes`
    );
    this.skipOversizedStatement = this.db.prepare(
      `UPDATE files SET content = '', state = ${STATE_SKIPPED} WHERE state != ${STATE_SKIPPED} AND size > @newBytes`
    );
    this.maxFileBytesStatement = this.db.prepare("SELECT value FROM meta WHERE key = 'max_file_bytes'");
    this.allFilesStatement = this.db.prepare(
      'SELECT path, modified_ms AS modifiedMs FROM files ORDER BY modified_ms DESC'
    );
    this.setMaxFileBytesStatement = this.db.prepare(
      "INSERT OR REPLACE INTO meta(key, value) VALUES ('max_file_bytes', ?)"
    );
    this.statsStatement = this.db.prepare(`
      SELECT
        coalesce(sum(state = ${STATE_INDEXED}), 0) AS indexed,
        coalesce(sum(state = ${STATE_PENDING}), 0) AS pending,
        coalesce(sum(state = ${STATE_SKIPPED}), 0) AS skipped
      FROM files
    `);
    this.matchStatement = this.db.prepare(previewSelect(`
      SELECT ${matchColumns}
      FROM files_fts JOIN files f ON f.id = files_fts.rowid
      WHERE files_fts MATCH @match AND f.state = ${STATE_INDEXED}
      ORDER BY f.modified_ms DESC
    `));
    this.likeStatement = this.db.prepare(previewSelect(`
      SELECT ${matchColumns}
      FROM files f
      WHERE f.state = ${STATE_INDEXED} AND f.content LIKE @like ESCAPE '\\'
      ORDER BY f.modified_ms DESC
    `));
  }

  beginScan() {
    return Date.now();
  }

  finishScan(scanId) {
    this.removeUnseenStatement.run(scanId);
    this.removeOrphanLayoutsStatement.run();
  }

  keepFilesUnder(root, scanId) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    this.keepFilesUnderStatement.run({ prefix, scanId });
  }

  isInitialIndexDone() {
    return Boolean(this.initialIndexDoneStatement.get());
  }

  markInitialIndexDone() {
    this.markInitialIndexDoneStatement.run();
  }

  nextPending() {
    return this.nextPendingStatement.get();
  }

  saveContent(file, content, layout = null) {
    this.db.transaction(() => {
      const { changes } = this.saveContentStatement.run({
        id: file.id, modifiedMs: file.modifiedMs, size: file.size, content
      });
      if (!changes) return;
      if (layout) this.saveLayoutStatement.run(file.id, JSON.stringify(layout));
      else this.deleteLayoutStatement.run(file.id);
    })();
  }

  markSkipped(id) {
    this.markSkippedStatement.run(id);
    this.deleteLayoutStatement.run(id);
  }

  // Finds the page box of the OCR'd words at content offset `start`. A match in the PDF text layer is
  // looked up again in the OCR text that follows it.
  ocrRegion(filePath, start, length) {
    const row = this.layoutStatement.get(filePath);
    if (!row) return null;
    const { offset, pages, words } = JSON.parse(row.layout);
    let from = start;
    if (from < offset) {
      const needle = row.content.slice(start, start + length).toLowerCase();
      from = row.content.toLowerCase().indexOf(needle, offset);
      if (from < 0) return null;
    }
    from -= offset;
    const to = from + length;

    let page = -1;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < words.length; i += 7) {
      const [wordPage, wordStart, wordEnd, x, y, width, height] = words.slice(i, i + 7);
      if (wordStart >= to) break;
      if (wordEnd <= from) continue;
      if (page === -1) page = wordPage;
      else if (wordPage !== page) break;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + width);
      bottom = Math.max(bottom, y + height);
    }
    if (page === -1 || !pages[page]) return null;
    const [pageWidth, pageHeight] = pages[page];
    return {
      modifiedMs: row.modifiedMs,
      page,
      pageWidth,
      pageHeight,
      box: { x: left, y: top, width: right - left, height: bottom - top }
    };
  }

  // Runs once per OCR engine: re-queues files skipped or read by an earlier engine, and files with
  // little text, which may hold pages that weren't OCR'd.
  requeueForOcr(engine, extensions, maxChars) {
    const current = this.db.prepare("SELECT value FROM meta WHERE key = 'ocr_engine'").get();
    if (current?.value === engine) return;
    const requeue = this.db.prepare(`
      UPDATE files SET state = ${STATE_PENDING}
      WHERE (state = ${STATE_SKIPPED} OR length(content) < @maxChars
        OR id IN (SELECT file_id FROM ocr_layouts))
        AND lower(path) LIKE @pattern
    `);
    this.db.transaction(() => {
      for (const extension of extensions) requeue.run({ maxChars, pattern: `%${extension}` });
      this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('ocr_engine', ?)").run(engine);
    })();
  }

  // Re-queue files previously skipped for size, or drops files now over the limit.
  applyMaxFileSize(newBytes) {
    // Indexes built before this setting existed may have skipped files at any size.
    const oldBytes = Number(this.maxFileBytesStatement.get()?.value ?? 0);
    if (newBytes > oldBytes) this.requeueSkippedStatement.run({ oldBytes, newBytes });
    else if (newBytes < oldBytes) this.skipOversizedStatement.run({ newBytes });
    this.setMaxFileBytesStatement.run(String(newBytes));
  }

  stats() {
    return this.statsStatement.get();
  }

  // Removes every indexed file and shrinks the database files on disk.
  clear() {
    this.db.transaction(() => {
      // Dropping the per-row FTS delete trigger and emptying FTS in one step is much faster for large indexes.
      this.db.exec(`
        DROP TRIGGER IF EXISTS files_ad;
        DELETE FROM files;
        DELETE FROM ocr_layouts;
        INSERT INTO files_fts(files_fts) VALUES ('delete-all');
        DELETE FROM meta WHERE key = 'initial_index_done';
        ${DELETE_TRIGGER}
      `);
    })();
    this.db.exec('VACUUM');
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  search(rawQuery, caseSensitive = false, searchFileNames = false) {
    const content = this.searchContent(rawQuery, caseSensitive);
    if (!searchFileNames) return content;
    const names = this.searchNames(rawQuery, caseSensitive);
    if (!names.length) return content;
    const seen = new Set(content.results.map((result) => result.path));
    const merged = [...content.results, ...names.filter((result) => !seen.has(result.path))]
      .sort((left, right) => right.modified - left.modified);
    return {
      results: merged.slice(0, this.maxResults),
      limitReached: content.limitReached || merged.length > this.maxResults
    };
  }

  searchNames(rawQuery, caseSensitive) {
    const booleanQuery = parseBooleanQuery(rawQuery);
    if (booleanQuery?.invalid) return [];
    let expression = booleanQuery?.expression;
    if (!expression) {
      const { query, wholeWord } = parseSearchQuery(rawQuery);
      if (!query) return [];
      expression = { type: 'term', query, wholeWord };
    }

    const none = { matched: false, highlights: [] };
    const evaluate = (node, name) => {
      if (node.type === 'term') {
        const highlights = findHighlights(name, node.query, node.wholeWord, caseSensitive);
        return highlights.length ? { matched: true, highlights } : none;
      }
      const left = evaluate(node.left, name);
      const right = evaluate(node.right, name);
      if (node.type === 'and') {
        return left.matched && right.matched
          ? { matched: true, highlights: [...left.highlights, ...right.highlights] }
          : none;
      }
      if (node.type === 'andNot') return left.matched && !right.matched ? left : none;
      return {
        matched: left.matched || right.matched,
        highlights: [...left.highlights, ...right.highlights]
      };
    };

    const results = [];
    for (const file of this.allFilesStatement.iterate()) {
      const name = path.basename(file.path);
      const result = evaluate(expression, name);
      if (!result.matched) continue;
      const highlights = [];
      for (const match of result.highlights.sort((left, right) => left.start - right.start)) {
        const previous = highlights.at(-1);
        if (previous && match.start < previous.start + previous.length) {
          previous.length = Math.max(previous.length, match.start + match.length - previous.start);
        } else {
          highlights.push({ ...match });
        }
      }
      results.push({
        path: file.path,
        name,
        modified: file.modifiedMs,
        matchCount: highlights.length,
        preview: name,
        highlights
      });
      if (results.length > this.maxResults) break;
    }
    return results;
  }

  searchContent(rawQuery, caseSensitive = false) {
    const booleanQuery = parseBooleanQuery(rawQuery);
    if (booleanQuery?.invalid) return { results: [], limitReached: false };
    if (booleanQuery) return this.searchBoolean(booleanQuery.expression, caseSensitive);

    const { query, wholeWord } = parseSearchQuery(rawQuery);
    if (!query) return { results: [], limitReached: false };
    const params = { query, before: PREVIEW_BEFORE, previewLength: PREVIEW_LENGTH };
    // Trigram MATCH needs at least 3 characters; shorter queries fall back to a LIKE scan.
    const statement = [...query].length >= MIN_TRIGRAM_QUERY_LENGTH
      ? this.matchStatement
      : this.likeStatement;
    const searchParams = [...query].length >= MIN_TRIGRAM_QUERY_LENGTH
      ? { ...params, match: `"${query.replaceAll('"', '""')}"` }
      : { ...params, like: `%${query.replace(/[\\%_]/g, '\\$&')}%` };

    const rows = [];
    for (const row of statement.iterate(searchParams)) {
      // FTS and LIKE ignore case, so exact matching is verified here.
      const exact = wholeWord || caseSensitive;
      const matches = exact ? findHighlights(row.content, query, wholeWord, caseSensitive) : null;
      if (exact && !matches.length) continue;
      rows.push({ row, matches });
      if (rows.length > this.maxResults) break;
    }

    const exact = wholeWord || caseSensitive;
    const results = rows.slice(0, this.maxResults).map(({ row, matches }) => {
      const matchPosition = exact ? matches[0].start + 1 : row.windowStart;
      const windowStart = exact ? Math.max(1, matchPosition - PREVIEW_BEFORE) : row.windowStart;
      const window = exact
        ? row.content.slice(windowStart - 1, windowStart - 1 + PREVIEW_LENGTH + query.length)
        : row.window;
      const prefix = windowStart > 1 ? '…' : '';
      const suffix = windowStart - 1 + [...window].length < row.textLength ? '…' : '';
      const highlights = findHighlights(window, query, wholeWord, caseSensitive)
        .map(({ start, length }) => ({ start: start + prefix.length, length }));
      const firstMatch = row.hasOcr ? (matches ?? findHighlights(row.content, query, false, false))[0] : null;
      return {
        path: row.path,
        name: path.basename(row.path),
        modified: row.modifiedMs,
        matchCount: exact ? matches.length : Math.max(row.matchCount, highlights.length, 1),
        preview: `${prefix}${window}${suffix}`,
        highlights,
        ocrMatch: firstMatch ? { start: firstMatch.start, length: firstMatch.length } : null
      };
    });

    return { results, limitReached: rows.length > this.maxResults };
  }

  searchBoolean(expression, caseSensitive = false) {
    const terms = [];
    const collectTerms = (node) => {
      if (node.type === 'term') {
        node.id = terms.length;
        terms.push(node);
        return;
      }
      collectTerms(node.left);
      collectTerms(node.right);
    };
    collectTerms(expression);

    const files = new Map();
    const termMatches = new Map();
    for (const term of terms) {
      const params = { query: term.query, before: PREVIEW_BEFORE, previewLength: PREVIEW_LENGTH };
      const statement = [...term.query].length >= MIN_TRIGRAM_QUERY_LENGTH
        ? this.matchStatement
        : this.likeStatement;
      const searchParams = [...term.query].length >= MIN_TRIGRAM_QUERY_LENGTH
        ? { ...params, match: `"${term.query.replaceAll('"', '""')}"` }
        : { ...params, like: `%${term.query.replace(/[\\%_]/g, '\\$&')}%` };
      const matches = new Set();
      for (const row of statement.iterate(searchParams)) {
        if ((term.wholeWord || caseSensitive)
          && !findHighlights(row.content, term.query, term.wholeWord, caseSensitive).length) continue;
        matches.add(row.path);
        files.set(row.path, row);
      }
      termMatches.set(term.id, matches);
    }

    const evaluate = (node, filePath) => {
      if (node.type === 'term') {
        return termMatches.get(node.id).has(filePath)
          ? { matched: true, terms: [node] }
          : { matched: false, terms: [] };
      }
      const left = evaluate(node.left, filePath);
      const right = evaluate(node.right, filePath);
      if (node.type === 'and') {
        return left.matched && right.matched
          ? { matched: true, terms: [...left.terms, ...right.terms] }
          : { matched: false, terms: [] };
      }
      if (node.type === 'andNot') {
        return left.matched && !right.matched ? left : { matched: false, terms: [] };
      }
      return {
        matched: left.matched || right.matched,
        terms: [...(left.matched ? left.terms : []), ...(right.matched ? right.terms : [])]
      };
    };

    const matchedFiles = [];
    for (const [filePath, row] of files) {
      const result = evaluate(expression, filePath);
      if (result.matched) matchedFiles.push({ row, terms: result.terms });
    }
    matchedFiles.sort((left, right) => right.row.modifiedMs - left.row.modifiedMs);
    const results = matchedFiles.slice(0, this.maxResults).map(({ row, terms: matchedTerms }) => {
      const matches = matchedTerms.flatMap((term) => findHighlights(row.content, term.query, term.wholeWord, caseSensitive))
        .sort((left, right) => left.start - right.start);
      const highlights = [];
      for (const match of matches) {
        const previous = highlights.at(-1);
        if (previous && match.start < previous.start + previous.length) {
          previous.length = Math.max(previous.length, match.start + match.length - previous.start);
        } else {
          highlights.push({ ...match });
        }
      }
      const windowStart = Math.max(1, highlights[0].start + 1 - PREVIEW_BEFORE);
      const longestTerm = Math.max(...matchedTerms.map((term) => term.query.length));
      const window = row.content.slice(windowStart - 1, windowStart - 1 + PREVIEW_LENGTH + longestTerm);
      const prefix = windowStart > 1 ? '…' : '';
      const suffix = windowStart - 1 + [...window].length < row.textLength ? '…' : '';
      const previewHighlights = highlights
        .filter(({ start }) => start >= windowStart - 1 && start < windowStart - 1 + window.length)
        .map(({ start, length }) => ({ start: start - windowStart + 1 + prefix.length, length }));
      return {
        path: row.path,
        name: path.basename(row.path),
        modified: row.modifiedMs,
        matchCount: highlights.length,
        preview: `${prefix}${window}${suffix}`,
        highlights: previewHighlights,
        ocrMatch: row.hasOcr ? { start: highlights[0].start, length: highlights[0].length } : null
      };
    });

    return { results, limitReached: matchedFiles.length > this.maxResults };
  };

  close() {
    this.db.close();
  }
}

module.exports = { FileIndex, MAX_RESULTS };
