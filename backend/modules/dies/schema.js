'use strict';

// ---------------------------------------------------------------------------
// The dies module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   dies
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS dies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_code TEXT NOT NULL UNIQUE,
      produced_part_numbers TEXT NOT NULL DEFAULT '[]',
      photo_urls TEXT NOT NULL DEFAULT '[]',
      operational_notes TEXT,
      compatible_machine_group_ids TEXT NOT NULL DEFAULT '[]',
      storage_location TEXT,
      number_of_cavities INTEGER,
      stroke_count INTEGER NOT NULL DEFAULT 0,
      max_strokes INTEGER NOT NULL DEFAULT 0,
      strokes_per_piece REAL,
      setup_minutes REAL,
      report_notes TEXT NOT NULL DEFAULT '',
      physical_specs TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      ownership TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await ensureColumnExists('dies', 'strokes_per_piece', 'REAL');

  await ensureColumnExists('dies', 'setup_minutes', 'REAL');

  await ensureColumnExists('dies', 'report_notes', "TEXT NOT NULL DEFAULT ''");
}

module.exports = { createSchema };
