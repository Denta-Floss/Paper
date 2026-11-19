'use strict';

// ---------------------------------------------------------------------------
// The action_center module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   delete_requests
//   deleted_records
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS delete_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_label TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by_user_id INTEGER NOT NULL REFERENCES users(id),
      reviewed_by_user_id INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS deleted_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      deleted_by TEXT
    )
  `);

  await ensureColumnExists('delete_requests', 'reviewed_note', "TEXT DEFAULT ''");
}

module.exports = { createSchema };
