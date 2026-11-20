'use strict';

// Hot backups: a consistent copy of paper.db while the server keeps working.
//
// `VACUUM INTO` writes a compacted copy of the database as of one read
// transaction. In WAL mode a reader does not block writers, so writes go on
// while it runs — but only if the copy is made on a connection of its own.
// The server shares one connection for every request; a VACUUM INTO on it
// would make every request queue behind the copy. So each backup opens, uses
// and closes its own connection (backup-restore.test.js checks a write lands
// while a backup is in progress).
//
// The copy is written under a temporary name and renamed when done, so a file
// named paper-<time>.db is always a finished one; then it is opened and
// `PRAGMA integrity_check` must answer "ok", or the file is removed and the
// backup reported failed. The newest `keep` backups are kept.
//
// Restoring: stop the server, copy a backup over paper.db, delete paper.db-wal
// and paper.db-shm if present, start the server. The backup is a plain SQLite
// database with no WAL of its own.
//
// What this is not: off-site. The backups sit on the same disk as the database
// (PAPER_BACKUP_DIR moves them); a lost disk loses both.

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const NAME = /^paper-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

function open(file, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, mode, (error) => (error ? reject(error) : resolve(db)));
  });
}

function call(db, method, sql, params = []) {
  return new Promise((resolve, reject) => {
    db[method](sql, params, function done(error, result) {
      if (error) reject(error);
      else resolve(method === 'run' ? this : result);
    });
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function createBackups({ dbPath, dir = path.join(path.dirname(dbPath), 'backups'), keep = 14, now = () => new Date() }) {
  let running = null;
  let timer = null;
  let last = null;

  /// Makes one backup and checks it. One at a time: a second call while one
  /// runs gets the same answer.
  function backup() {
    if (running) return running;
    running = make().finally(() => { running = null; });
    return running;
  }

  async function make() {
    const started = Date.now();
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `paper-${stamp(now())}.db`);
    const partPath = `${finalPath}.part`;
    let source = null;
    try {
      source = await open(dbPath, sqlite3.OPEN_READWRITE);
      await call(source, 'run', 'PRAGMA busy_timeout = 5000');
      await call(source, 'run', 'VACUUM INTO ?', [partPath]);
    } catch (error) {
      fs.rmSync(partPath, { force: true });
      last = { ok: false, at: new Date().toISOString(), error: String(error.message || error) };
      throw error;
    } finally {
      if (source) await close(source);
    }
    fs.renameSync(partPath, finalPath);

    const integrity = await verify(finalPath);
    if (integrity !== 'ok') {
      fs.rmSync(finalPath, { force: true });
      last = { ok: false, at: new Date().toISOString(), error: `integrity_check: ${integrity}` };
      throw new Error(`The backup failed its integrity check: ${integrity}`);
    }
    const removed = prune();
    last = {
      ok: true,
      at: new Date().toISOString(),
      file: path.basename(finalPath),
      path: finalPath,
      bytes: fs.statSync(finalPath).size,
      durationMs: Date.now() - started,
      integrity,
      removed,
    };
    return last;
  }

  /// `PRAGMA integrity_check` on a backup, read-only. "ok", or what it found.
  async function verify(file) {
    const db = await open(file, sqlite3.OPEN_READONLY);
    try {
      const rows = await call(db, 'all', 'PRAGMA integrity_check');
      const messages = rows.map((row) => Object.values(row)[0]);
      return messages.length === 1 && messages[0] === 'ok' ? 'ok' : messages.join('; ');
    } finally {
      await close(db);
    }
  }

  /// Finished backups, newest first.
  function list() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => NAME.test(name))
      .sort()
      .reverse()
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return { file: name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      });
  }

  function prune() {
    const removed = [];
    for (const old of list().slice(Math.max(1, keep))) {
      fs.rmSync(path.join(dir, old.file), { force: true });
      removed.push(old.file);
    }
    return removed;
  }

  /// Every `everyMs`, starting one interval from now. Failures are recorded in
  /// `last` and logged; the next run tries again.
  function schedule(everyMs) {
    if (timer || !(everyMs > 0)) return;
    timer = setInterval(() => {
      backup().catch((error) => console.error(`[backup] failed: ${error.message}`));
    }, everyMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { backup, verify, list, prune, schedule, stop, dir, get last() { return last; } };
}

module.exports = { createBackups, NAME };
