const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { createBackups } = require('../kernel/backup');

function verifyFile(file) {
  return createBackups({ dbPath: file, dir: path.dirname(file) }).verify(file);
}

function vacuumInto(source, target) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(source, (openError) => {
      if (openError) return reject(openError);
      db.run('VACUUM INTO ?', [target], (error) => db.close(() => (error ? reject(error) : resolve())));
    });
  });
}

const dbPath = String(process.env.DB_PATH || path.join(__dirname, '..', 'paper.db'));
const backupFile =
  String(process.env.PAPER_RESTORE_FILE || '').trim() ||
  process.argv[2] ||
  path.join(__dirname, '..', 'backups', 'paper-latest.db');

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Restores a backup over the database. STOP THE SERVER FIRST.
//
// Two things the old version got wrong (B57): it copied the backup over
// paper.db and left paper.db-wal beside it, so SQLite would replay the old
// log on top of the restored file; and its safety copy of the current database
// was a plain file copy, missing whatever was still in the WAL. Now the backup
// is checked before anything is touched, the current database is saved with
// VACUUM INTO (WAL included), and the -wal/-shm files are removed.
async function main() {
  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file not found at ${backupFile}`);
  }
  const integrity = await verifyFile(backupFile);
  if (integrity !== 'ok') {
    throw new Error(`The backup failed its integrity check, nothing was changed: ${integrity}`);
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) {
    const rollbackCopy = `${dbPath}.pre-restore-${timestamp()}`;
    await vacuumInto(dbPath, rollbackCopy);
    console.log(`Current DB saved at ${rollbackCopy}`);
  }
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.copyFileSync(backupFile, dbPath);
  console.log(`Restored ${backupFile} -> ${dbPath} (integrity ok). Start the server.`);
}

main().catch((error) => {
  console.error('Restore failed:', error.message);
  process.exit(1);
});
