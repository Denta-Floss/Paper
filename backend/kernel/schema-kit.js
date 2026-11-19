'use strict';

// ---------------------------------------------------------------------------
// What a module's schema.js needs besides CREATE TABLE IF NOT EXISTS.
//
// ensureColumnExists adds a column to a table an older database file already
// has. It is how a column is added here: no migration file, the column goes
// into the CREATE statement for new files and this call covers the old ones.
// ---------------------------------------------------------------------------

async function ensureColumnExists({ run, all }, tableName, columnName, definition) {
  const columns = await all(`PRAGMA table_info(${tableName})`);
  const hasColumn = columns.some((column) => column.name === columnName);
  if (!hasColumn) {
    console.log(`Migrating ${tableName}: adding ${columnName}`);
    await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

module.exports = { ensureColumnExists };
