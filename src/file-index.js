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
  SELECT path, modifiedMs, textLength, matchCount, content,
    max(1, position - @before) AS windowStart,
    substr(content, max(1, position - @before), length(@query) + @previewLength) AS window
  FROM (${innerQuery})
  ORDER BY modifiedMs DESC
`;

const matchColumns = `
  f.path, f.modified_ms AS modifiedMs, f.content, length(f.content) AS textLength,
  instr(lower(f.content), lower(@query)) AS position,
  (length(lower(f.content)) - length(replace(lower(f.content), lower(@query), ''))) / length(@query) AS matchCount
`;

class FileIndex {
  constructor(databasePath) {
    this.db = new Database(databasePath);
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

      -- Trigram tokens give case-insensitive substring matching, including for CJK text.
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        content, content='files', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
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

  saveContent(file, content) {
    this.saveContentStatement.run({ id: file.id, modifiedMs: file.modifiedMs, size: file.size, content });
  }

  markSkipped(id) {
    this.markSkippedStatement.run(id);
  }

  stats() {
    return this.statsStatement.get();
  }

  search(rawQuery) {
    const booleanQuery = parseBooleanQuery(rawQuery);
    if (booleanQuery?.invalid) return { results: [], limitReached: false };
    if (booleanQuery) return this.searchBoolean(booleanQuery.expression);

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
      const matches = wholeWord ? findHighlights(row.content, query, true) : null;
      if (wholeWord && !matches.length) continue;
      rows.push({ row, matches });
      if (rows.length > MAX_RESULTS) break;
    }

    const results = rows.slice(0, MAX_RESULTS).map(({ row, matches }) => {
      const matchPosition = wholeWord ? matches[0].start + 1 : row.windowStart;
      const windowStart = wholeWord ? Math.max(1, matchPosition - PREVIEW_BEFORE) : row.windowStart;
      const window = wholeWord
        ? row.content.slice(windowStart - 1, windowStart - 1 + PREVIEW_LENGTH + query.length)
        : row.window;
      const prefix = windowStart > 1 ? '…' : '';
      const suffix = windowStart - 1 + [...window].length < row.textLength ? '…' : '';
      const highlights = (wholeWord ? findHighlights(window, query, true) : findHighlights(window, query))
        .map(({ start, length }) => ({ start: start + prefix.length, length }));
      return {
        path: row.path,
        name: path.basename(row.path),
        modified: row.modifiedMs,
        matchCount: wholeWord ? matches.length : Math.max(row.matchCount, highlights.length, 1),
        preview: `${prefix}${window}${suffix}`,
        highlights
      };
    });

    return { results, limitReached: rows.length > MAX_RESULTS };
  }

  searchBoolean(expression) {
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
        if (term.wholeWord && !findHighlights(row.content, term.query, true).length) continue;
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
    const results = matchedFiles.slice(0, MAX_RESULTS).map(({ row, terms: matchedTerms }) => {
      const matches = matchedTerms.flatMap((term) => findHighlights(row.content, term.query, term.wholeWord))
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
        highlights: previewHighlights
      };
    });

    return { results, limitReached: matchedFiles.length > MAX_RESULTS };
  };

  close() {
    this.db.close();
  }
}

module.exports = { FileIndex, MAX_RESULTS };
