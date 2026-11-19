'use strict';

// ---------------------------------------------------------------------------
// The items module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   group_item_memberships
//   item_attachments
//   item_bom_lines
//   item_dies
//   item_machines
//   item_property_schema
//   item_unit_conversions
//   item_variation_dimensions
//   item_variation_nodes
//   item_variation_values
//   item_variations
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS group_item_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(group_id, item_id)
    );
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_group_item_memberships_group ON group_item_memberships(group_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_group_item_memberships_item ON group_item_memberships(item_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS item_unit_conversions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      factor_to_primary REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(item_id, unit_id)
    )
  `);

  await run(
    'CREATE INDEX IF NOT EXISTS idx_item_unit_conversions_item_id ON item_unit_conversions(item_id)',
  );

  await run(`
    CREATE TABLE IF NOT EXISTS item_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      object_key TEXT NOT NULL,
      file_name TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(
    'CREATE INDEX IF NOT EXISTS idx_item_attachments_item_id ON item_attachments(item_id)',
  );

  await run(`
    CREATE TABLE IF NOT EXISTS item_machines (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_id, machine_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS item_dies (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      die_id INTEGER NOT NULL REFERENCES dies(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_id, die_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS item_property_schema (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      property_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      input_type TEXT NOT NULL DEFAULT 'Text',
      mandatory INTEGER NOT NULL DEFAULT 0,
      unit_id INTEGER,
      unit_symbol TEXT,
      unit_label TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_group_id INTEGER,
      source_group_name TEXT,
      source_item_ids_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(item_id, property_key)
    )
  `);

  await run(
    'CREATE INDEX IF NOT EXISTS idx_item_property_schema_item_id ON item_property_schema(item_id)',
  );

  await run(`
    CREATE TABLE IF NOT EXISTS item_bom_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      material_barcode TEXT NOT NULL,
      material_name TEXT DEFAULT '',
      quantity_per_unit REAL NOT NULL DEFAULT 1,
      wastage_percent REAL NOT NULL DEFAULT 0,
      unit_id INTEGER REFERENCES units(id),
      unit_symbol TEXT DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(item_id, material_barcode)
    )
  `);

  await run(
    'CREATE INDEX IF NOT EXISTS idx_item_bom_lines_item_id ON item_bom_lines(item_id, sort_order ASC, id ASC)',
  );

  await run(`
    CREATE TABLE IF NOT EXISTS item_variations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      alias TEXT DEFAULT '',
      display_name TEXT NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS item_variation_dimensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS item_variation_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variation_id INTEGER NOT NULL REFERENCES item_variations(id) ON DELETE CASCADE,
      dimension_id INTEGER NOT NULL REFERENCES item_variation_dimensions(id) ON DELETE CASCADE,
      value TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS item_variation_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      parent_node_id INTEGER REFERENCES item_variation_nodes(id) ON DELETE CASCADE CHECK (parent_node_id IS NULL OR parent_node_id > 0),
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await ensureColumnExists('item_unit_conversions', 'factor_to_primary', 'REAL NOT NULL DEFAULT 1');

  await ensureColumnExists('item_variations', 'alias', "TEXT DEFAULT ''");

  await ensureColumnExists('item_variations', 'display_name', "TEXT DEFAULT ''");

  await ensureColumnExists('item_variation_nodes', 'code', "TEXT NOT NULL DEFAULT ''");

  await ensureColumnExists('item_variation_nodes', 'name_join', "TEXT NOT NULL DEFAULT ''");

  await ensureColumnExists('item_variation_nodes', 'input_type', "TEXT NOT NULL DEFAULT 'Text'");

  await ensureColumnExists('item_variation_nodes', 'material_type_id', 'INTEGER');

  await ensureColumnExists('item_variation_nodes', 'numeric_min', 'REAL');

  await ensureColumnExists('item_variation_nodes', 'numeric_max', 'REAL');
}

module.exports = { createSchema };
