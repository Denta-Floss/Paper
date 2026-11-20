'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');
const { makeTempDir } = require('./helpers/temp-dir');

// Hot backups (kernel/backup.js): a consistent copy while the server keeps
// writing, that restores and passes integrity_check.

const run = promisify(execFile);

function openDb(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(db)));
  });
}
const query = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))));
const closeDb = (db) => new Promise((resolve) => db.close(() => resolve()));

async function vendorsIn(file) {
  const db = await openDb(file);
  try {
    return (await query(db, 'SELECT name FROM vendors')).map((row) => row.name);
  } finally {
    await closeDb(db);
  }
}

async function integrityOf(file) {
  const db = await openDb(file);
  try {
    return (await query(db, 'PRAGMA integrity_check')).map((row) => Object.values(row)[0]).join('; ');
  } finally {
    await closeDb(db);
  }
}

async function boot(t, { dbPath, reset = true }) {
  process.env.DB_PATH = dbPath;
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'backup-owner@paper.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  if (reset) await backend.resetAndSeedDemoData('scenario_a');
  else await backend.initDb();
  const server = http.createServer(backend.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = (await (await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'backup-owner@paper.test', password: 'OwnerPass1234' }),
  })).json()).token;
  const call = (method, route, body) => fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { backend, baseUrl, token, call };
}

test('a backup holds what is still in the WAL, passes integrity_check, and a server started on it has the data', async (t) => {
  const dir = makeTempDir('paper-backup-');
  const dbPath = path.join(dir, 'paper.db');
  const ctx = await boot(t, { dbPath });

  // Everything so far into the main file; the next write lives only in the WAL.
  await ctx.backend.get('PRAGMA wal_checkpoint(TRUNCATE)');
  const made = await ctx.call('POST', '/api/vendors', { name: 'Only In The WAL Ltd' });
  assert.equal(made.status, 201, await made.clone().text());
  assert.ok(fs.statSync(`${dbPath}-wal`).size > 0);

  // B56: what the old backup script did — copy the file.
  const plainCopy = path.join(dir, 'plain-copy.db');
  fs.copyFileSync(dbPath, plainCopy);
  assert.ok(!(await vendorsIn(plainCopy)).includes('Only In The WAL Ltd'),
    'a file copy leaves out writes not yet checkpointed — why the old script was wrong');

  const response = await ctx.call('POST', '/api/system/backups');
  assert.equal(response.status, 201, await response.clone().text());
  const { backup } = await response.json();
  assert.equal(backup.integrity, 'ok');
  assert.match(backup.file, /^paper-\d{4}-\d{2}-\d{2}T.*Z\.db$/);
  assert.equal(backup.path, undefined, 'the answer names the file, not where the disk keeps it');
  const listed = await (await ctx.call('GET', '/api/system/backups')).json();
  assert.equal(listed.backups[0].file, backup.file);
  assert.equal(listed.last.ok, true);

  const backupPath = path.join(dir, 'backups', backup.file);
  assert.ok((await vendorsIn(backupPath)).includes('Only In The WAL Ltd'), 'VACUUM INTO reads through the WAL');
  assert.ok(!fs.existsSync(`${backupPath}-wal`), 'a backup is one self-contained file');

  // Restore it somewhere else and start a server on it.
  const restoredDir = makeTempDir('paper-restored-');
  const restored = path.join(restoredDir, 'paper.db');
  fs.copyFileSync(backupPath, restored);
  assert.equal(await integrityOf(restored), 'ok');
  const again = await boot(t, { dbPath: restored, reset: false });
  assert.ok(again.token, 'the restored accounts sign in');
  const vendors = await (await again.call('GET', '/api/vendors')).json();
  assert.ok(JSON.stringify(vendors).includes('Only In The WAL Ltd'), 'and the restored server serves the data');
});

test('writes go on while a backup runs: it has a connection of its own', async (t) => {
  const dir = makeTempDir('paper-backup-busy-');
  const ctx = await boot(t, { dbPath: path.join(dir, 'paper.db') });
  // Enough to make the copy take a while.
  await ctx.backend.run('CREATE TABLE IF NOT EXISTS backup_ballast (b BLOB)');
  await ctx.backend.run(`INSERT INTO backup_ballast
    SELECT randomblob(200000) FROM (WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n LIMIT 400) SELECT x FROM n)`);

  let backupDoneAt = 0;
  const backup = ctx.backend.serverBackups.backup().then((result) => { backupDoneAt = Date.now(); return result; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const writeStartedAt = Date.now();
  const write = await ctx.call('POST', '/api/vendors', { name: 'Written During The Backup' });
  const writeDoneAt = Date.now();
  assert.equal(write.status, 201);
  const result = await backup;
  assert.equal(result.integrity, 'ok');
  assert.ok(result.bytes > 70 * 1000 * 1000, `a large copy (${result.bytes} bytes)`);
  // Measured: the copy took ~126 ms, the write 5 ms, done 115 ms before it.
  assert.ok(writeDoneAt - writeStartedAt < result.durationMs / 2,
    `the write took ${writeDoneAt - writeStartedAt} ms during a ${result.durationMs} ms backup`);
  assert.ok(writeDoneAt < backupDoneAt,
    `the write finished (${writeDoneAt}) before the backup did (${backupDoneAt}); it did not wait behind it`);
});

test('the scripts: backup-sqlite makes a checked copy; restore-sqlite removes a stale WAL and refuses a damaged backup', async (t) => {
  const dir = makeTempDir('paper-backup-script-');
  const dbPath = path.join(dir, 'paper.db');
  const ctx = await boot(t, { dbPath });
  await ctx.backend.get('PRAGMA wal_checkpoint(TRUNCATE)');
  await ctx.call('POST', '/api/vendors', { name: 'Script Era Vendor' });

  const env = { ...process.env, DB_PATH: dbPath, PAPER_BACKUP_DIR: path.join(dir, 'nightly'), PAPER_S3_BUCKET_NAME: '' };
  const made = await run(process.execPath, [path.join(__dirname, '..', 'scripts', 'backup-sqlite.js')], { env });
  assert.match(made.stdout, /integrity ok/);
  const nightly = fs.readdirSync(path.join(dir, 'nightly'));
  assert.ok(nightly.includes('paper-latest.db'));
  const dated = nightly.find((name) => /^paper-\d{4}.*Z\.db$/.test(name));
  assert.ok(dated, nightly.join(', '));
  assert.ok((await vendorsIn(path.join(dir, 'nightly', dated))).includes('Script Era Vendor'));

  // Restore over a database that has a WAL of its own (B57).
  const target = path.join(makeTempDir('paper-restore-target-'), 'paper.db');
  fs.copyFileSync(dbPath, target);
  fs.writeFileSync(`${target}-wal`, Buffer.alloc(4096, 7));
  const restoreScript = path.join(__dirname, '..', 'scripts', 'restore-sqlite.js');
  await run(process.execPath, [restoreScript, path.join(dir, 'nightly', dated)], { env: { ...process.env, DB_PATH: target } });
  assert.ok(!fs.existsSync(`${target}-wal`), 'the stale WAL is gone, so it cannot be replayed over the restore');
  assert.equal(await integrityOf(target), 'ok');
  assert.ok((await vendorsIn(target)).includes('Script Era Vendor'));
  assert.ok(fs.readdirSync(path.dirname(target)).some((name) => name.startsWith('paper.db.pre-restore-')), 'the replaced database was kept');

  const broken = path.join(dir, 'broken.db');
  fs.writeFileSync(broken, Buffer.concat([fs.readFileSync(path.join(dir, 'nightly', dated)).subarray(0, 8192), Buffer.alloc(8192, 1)]));
  const before = fs.readFileSync(target);
  await assert.rejects(
    run(process.execPath, [restoreScript, broken], { env: { ...process.env, DB_PATH: target } }),
    'a damaged backup is refused',
  );
  assert.ok(fs.readFileSync(target).equals(before), 'and nothing was changed');
});
