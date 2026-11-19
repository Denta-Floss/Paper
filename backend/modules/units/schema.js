'use strict';

// ---------------------------------------------------------------------------
// The units module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   unit_conversion_points
//   unit_groups
//   units
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS unit_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      unit_group_id INTEGER REFERENCES unit_groups(id),
      conversion_factor REAL NOT NULL DEFAULT 1,
      conversion_base_unit_id INTEGER REFERENCES units(id),
      notes TEXT DEFAULT '',
      is_archived INTEGER NOT NULL DEFAULT 0,
      logo_url TEXT DEFAULT '',
      photo_url TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await ensureColumnExists('units', 'unit_group_id', 'INTEGER');

  await ensureColumnExists('units', 'conversion_factor', 'REAL NOT NULL DEFAULT 1');

  await ensureColumnExists('units', 'conversion_base_unit_id', 'INTEGER');

  // Bootstrap parity with migrations/026-units-families.sql — fresh DBs (tests,
  // new deployments seeding before first boot) must match migrated DBs.
  await ensureColumnExists('unit_groups', 'dimension', 'TEXT');

  await ensureColumnExists('unit_groups', 'base_unit_id', 'INTEGER');

  await ensureColumnExists('units', 'conversion_type', "TEXT NOT NULL DEFAULT 'linear'");

  await ensureColumnExists('units', 'precision', 'INTEGER');

  // Bootstrap parity with migrations/051-units-contract-ladders.sql
  await ensureColumnExists('unit_groups', 'code', 'TEXT');

  await ensureColumnExists('unit_groups', 'integral_only', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('units', 'factor_to_base', 'INTEGER NOT NULL DEFAULT 1');

  await ensureColumnExists('units', 'is_base', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('units', 'on_ladder', 'INTEGER NOT NULL DEFAULT 1');

  await ensureColumnExists('units', 'uqc', 'TEXT');

  await run(`
    CREATE TABLE IF NOT EXISTS unit_conversion_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      point_key TEXT NOT NULL,
      base_value REAL NOT NULL,
      UNIQUE(unit_id, point_key)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_unit_conversion_points_unit_id ON unit_conversion_points(unit_id)');
}

module.exports = { createSchema };
