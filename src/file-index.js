const path = require('node:path');
const Database = require('better-sqlite3');
const { findHighlights } = require('./search');

const MAX_RESULTS = 500;
const PREVIEW_BEFORE = 80;
const PREVIEW_LENGTH = 240;
const MIN_TRIGRAM_QUERY_LENGTH = 3;

const STATE_PENDING = 0;
const STATE_INDEXED = 1;
const STATE_SKIPPED = 2;

// Wraps the FTS query so both search paths return a small preview window instead of full file text.
const previewSelect = (innerQuery) => `
  SELECT path, modifiedMs, textLength, matchCount,
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
      ORDER BY f.modified_ms DESC LIMIT @limit
    `));
    this.likeStatement = this.db.prepare(previewSelect(`
      SELECT ${matchColumns}
      FROM files f
      WHERE f.state = ${STATE_INDEXED} AND f.content LIKE @like ESCAPE '\\'
      ORDER BY f.modified_ms DESC LIMIT @limit
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
    const query = rawQuery.replace(/\s+/g, ' ').trim();
    const params = { query, before: PREVIEW_BEFORE, previewLength: PREVIEW_LENGTH, limit: MAX_RESULTS + 1 };
    // Trigram MATCH needs at least 3 characters; shorter queries fall back to a LIKE scan.
    const rows = [...query].length >= MIN_TRIGRAM_QUERY_LENGTH
      ? this.matchStatement.all({ ...params, match: `"${query.replaceAll('"', '""')}"` })
      : this.likeStatement.all({ ...params, like: `%${query.replace(/[\\%_]/g, '\\$&')}%` });

    const results = rows.slice(0, MAX_RESULTS).map((row) => {
      const prefix = row.windowStart > 1 ? '…' : '';
      const suffix = row.windowStart - 1 + [...row.window].length < row.textLength ? '…' : '';
      const highlights = findHighlights(row.window, query)
        .map(({ start, length }) => ({ start: start + prefix.length, length }));
      return {
        path: row.path,
        name: path.basename(row.path),
        modified: row.modifiedMs,
        matchCount: Math.max(row.matchCount, highlights.length, 1),
        preview: `${prefix}${row.window}${suffix}`,
        highlights
      };
    });

    return { results, limitReached: rows.length > MAX_RESULTS };
  }

  close() {
    this.db.close();
  }
}

module.exports = { FileIndex, MAX_RESULTS };
