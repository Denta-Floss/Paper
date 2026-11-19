'use strict';

// ---------------------------------------------------------------------------
// The people module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   departments
//   employees
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      photo_url TEXT DEFAULT '',
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      aadhar_number TEXT DEFAULT '',
      aadhar_photo_url TEXT DEFAULT '',
      pan_number TEXT DEFAULT '',
      pan_photo_url TEXT DEFAULT '',
      address TEXT DEFAULT '',
      employee_photo_url TEXT DEFAULT '',
      employment_type TEXT DEFAULT 'in-house',
      status TEXT DEFAULT 'active',
      barcode_id TEXT DEFAULT '',
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE CASCADE
    )
  `);
}

module.exports = { createSchema };
