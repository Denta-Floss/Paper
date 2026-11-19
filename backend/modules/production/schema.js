'use strict';

// ---------------------------------------------------------------------------
// The production module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   order_pipeline_assignments
//   pipeline_runs
//   production_runs
//   production_scrap
//   run_barcode_inputs
//   run_machine_assignments
//   stage_reconciliations
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS production_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'completed',
      completed_at TEXT,
      item_id INTEGER NOT NULL REFERENCES items(id),
      variation_leaf_node_id INTEGER NOT NULL DEFAULT 0,
      variation_path_label TEXT DEFAULT '',
      output_quantity REAL NOT NULL DEFAULT 0,
      uom TEXT DEFAULT 'pcs',
      location TEXT DEFAULT '',
      source_metadata_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_production_runs_status ON production_runs(status, completed_at)');

  await run('CREATE INDEX IF NOT EXISTS idx_production_runs_item ON production_runs(item_id, variation_leaf_node_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES pipeline_templates(id),
      template_version INTEGER NOT NULL,
      name TEXT,
      status TEXT DEFAULT 'planned',
      overrides_json TEXT,
      node_status_json TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await ensureColumnExists('pipeline_runs', 'scrap_routing', "TEXT DEFAULT 'inventory'");

  await ensureColumnExists('pipeline_runs', 'node_metrics_json', "TEXT DEFAULT '{}'");

  await ensureColumnExists('pipeline_runs', 'batches_json', "TEXT DEFAULT '[]'");

  await ensureColumnExists('pipeline_runs', 'created_by', 'TEXT');

  await ensureColumnExists('pipeline_runs', 'weight_kg', 'REAL DEFAULT 0');

  await run(`
    CREATE TABLE IF NOT EXISTS run_machine_assignments (
      run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      machine_id INTEGER REFERENCES machines(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, node_id)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_run_machine_assignments_machine ON run_machine_assignments(machine_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS stage_reconciliations (
      run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
      node_id TEXT NOT NULL,
      allotted REAL,
      output REAL,
      leftover REAL,
      scrap REAL,
      good_yield REAL,
      actual_hours REAL,
      scrap_item_id INTEGER,
      scrap_item_name TEXT,
      leftover_action TEXT,
      input_time TEXT,
      output_time TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS production_scrap (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
      node_id TEXT NOT NULL,
      order_no TEXT,
      material_barcode TEXT NOT NULL,
      scrap_qty REAL NOT NULL DEFAULT 0,
      logged_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS run_barcode_inputs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
      node_id TEXT NOT NULL,
      barcode TEXT NOT NULL,
      material_id TEXT,
      material_payload_json TEXT NOT NULL,
      scanned_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await ensureColumnExists('run_barcode_inputs', 'source_kind', "TEXT DEFAULT 'sku'");

  await ensureColumnExists('run_barcode_inputs', 'piece_parent_code', 'TEXT');

  await ensureColumnExists('run_barcode_inputs', 'piece_child_code', 'TEXT');

  await ensureColumnExists('run_barcode_inputs', 'challan_item_id', 'INTEGER');

  await ensureColumnExists('run_barcode_inputs', 'consumed_weight', 'REAL DEFAULT 0');

  await run('CREATE INDEX IF NOT EXISTS idx_run_barcode_inputs_parent ON run_barcode_inputs(piece_parent_code)');

  await run(`
    CREATE TABLE IF NOT EXISTS order_pipeline_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      allocated_quantity REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_order_pipeline_assignments_order_id ON order_pipeline_assignments(order_item_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_order_pipeline_assignments_pipeline_run_id ON order_pipeline_assignments(pipeline_run_id)');
}

module.exports = { createSchema };
