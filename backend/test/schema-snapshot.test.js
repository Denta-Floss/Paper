const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { makeTempDir } = require('./helpers/temp-dir');

// The schema the server builds, pinned. Stage 2d moves the CREATE TABLE
// statements out of initDb into each module's schema.js; this is the oracle
// that says nothing about the result changed. Two ways in:
//
//   fresh     an empty file: the migrations, then initDb;
//   legacy    a file holding only the first migration's tables, with both
//             migration ledgers already marked complete, so that initDb's own
//             column checks and rebuilds are what bring it up to date.
//
// Re-record with UPDATE_SCHEMA_SNAPSHOT=1 after a change that is meant to
// alter the schema, and say so in the tracking document.

const FIXTURE = path.join(__dirname, 'fixtures', 'schema-snapshot.json');
const MIGRATIONS = path.join(__dirname, '..', 'migrations');

function openRaw(file) {
  const db = new sqlite3.Database(file);
  const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (error) => (error ? reject(error) : resolve())));
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (error) => (error ? reject(error) : resolve())));
  const close = () => new Promise((resolve) => db.close(resolve));
  return { exec, run, close };
}

async function schemaOf(backend) {
  const rows = await backend.all(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
  return rows.map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: row.sql == null ? null : String(row.sql).replace(/\s+/g, ' ').trim(),
  }));
}

async function bootFresh() {
  const tempDir = makeTempDir('paper-schema-fresh-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  delete require.cache[require.resolve('../server.js')];
  delete require.cache[require.resolve('../migrate.js')];
  const backend = require('../server.js');
  await require('../migrate.js').runMigrations();
  await backend.initDb();
  return backend;
}

async function bootLegacy() {
  const tempDir = makeTempDir('paper-schema-legacy-');
  const file = path.join(tempDir, 'paper.db');
  const raw = openRaw(file);
  await raw.exec(fs.readFileSync(path.join(MIGRATIONS, '001-init.sql'), 'utf8'));
  // Both ledgers say every migration has run, so none does.
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') || f.endsWith('.js')).sort();
  await raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'applied')`);
  for (const name of files) {
    await raw.run('INSERT INTO _migrations (name) VALUES (?)', [name]);
    await raw.run("INSERT INTO schema_migrations (name, applied_at, outcome) VALUES (?, ?, 'applied')", [name, '2026-01-01T00:00:00.000Z']);
  }
  await raw.close();
  process.env.DB_PATH = file;
  delete require.cache[require.resolve('../server.js')];
  delete require.cache[require.resolve('../migrate.js')];
  const backend = require('../server.js');
  await require('../migrate.js').runMigrations();
  await backend.initDb();
  return backend;
}

test('the schema the server builds is the one in the fixture, from an empty file and from a legacy one', async () => {
  const snapshot = {
    fresh: await schemaOf(await bootFresh()),
    legacy: await schemaOf(await bootLegacy()),
  };
  assert.ok(snapshot.fresh.filter((row) => row.type === 'table').length > 100, 'the fresh schema has the tables');

  if (process.env.UPDATE_SCHEMA_SNAPSHOT === '1') {
    fs.writeFileSync(FIXTURE, `${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const way of ['fresh', 'legacy']) {
    const have = new Map(snapshot[way].map((row) => [`${row.type} ${row.name}`, row]));
    const want = new Map(expected[way].map((row) => [`${row.type} ${row.name}`, row]));
    const added = [...have.keys()].filter((key) => !want.has(key));
    const removed = [...want.keys()].filter((key) => !have.has(key));
    const changed = [...have.keys()].filter((key) => want.has(key) && JSON.stringify(have.get(key)) !== JSON.stringify(want.get(key)));
    assert.deepEqual(
      { added, removed, changed },
      { added: [], removed: [], changed: [] },
      `the ${way} schema changed; if intended, run UPDATE_SCHEMA_SNAPSHOT=1 npm test and record why`,
    );
  }
});
