'use strict';

// ---------------------------------------------------------------------------
// The clients module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   sub_contractors
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS sub_contractors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

module.exports = { createSchema };
