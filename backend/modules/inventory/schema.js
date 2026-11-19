'use strict';

// ---------------------------------------------------------------------------
// The inventory module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   inventory_alerts
//   inventory_movements
//   inventory_reservations
//   inventory_set_lines
//   inventory_sets
//   material_activity
//   material_group_item_links
//   material_group_preferences
//   material_group_properties
//   material_group_units
//   materials
//   scan_history
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all, get }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      grade TEXT,
      thickness TEXT,
      supplier TEXT,
      location TEXT,
      unit_id INTEGER,
      unit TEXT,
      notes TEXT,
      group_mode TEXT,
      inheritance_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_barcode TEXT,
      number_of_children INTEGER NOT NULL DEFAULT 0,
      linked_child_barcodes TEXT,
      scan_count INTEGER NOT NULL DEFAULT 0,
      linked_group_id INTEGER REFERENCES groups(id),
      linked_item_id INTEGER REFERENCES items(id),
      linked_variation_leaf_node_id INTEGER REFERENCES item_variation_nodes(id),
      custom_variation_values_json TEXT DEFAULT '{}',
      display_stock TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      workflow_status TEXT DEFAULT 'notStarted',
      material_class TEXT DEFAULT 'raw_material',
      inventory_state TEXT DEFAULT 'available',
      procurement_state TEXT DEFAULT 'not_ordered',
      traceability_mode TEXT DEFAULT 'bulk',
      on_hand_qty REAL NOT NULL DEFAULT 0,
      reserved_qty REAL NOT NULL DEFAULT 0,
      available_to_promise_qty REAL NOT NULL DEFAULT 0,
      incoming_qty REAL NOT NULL DEFAULT 0,
      linked_order_count INTEGER NOT NULL DEFAULT 0,
      linked_pipeline_count INTEGER NOT NULL DEFAULT 0,
      pending_alert_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      last_scanned_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS scan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL,
      scanned_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS material_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_label TEXT NOT NULL,
      event_description TEXT DEFAULT '',
      actor TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS material_group_item_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL REFERENCES materials(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(material_id, item_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS material_group_properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL REFERENCES materials(id),
      property_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      input_type TEXT NOT NULL DEFAULT 'Text',
      mandatory INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_item_ids_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'active',
      override_locked INTEGER NOT NULL DEFAULT 0,
      has_type_conflict INTEGER NOT NULL DEFAULT 0,
      coverage_count INTEGER NOT NULL DEFAULT 0,
      selected_item_count_at_resolution INTEGER NOT NULL DEFAULT 0,
      resolution_source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(material_id, property_key)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS material_group_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL REFERENCES materials(id),
      unit_id INTEGER NOT NULL REFERENCES units(id),
      state TEXT NOT NULL DEFAULT 'active',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(material_id, unit_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS material_group_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL REFERENCES materials(id),
      common_only_mode INTEGER NOT NULL DEFAULT 1,
      show_partial_matches INTEGER NOT NULL DEFAULT 1,
      discarded_property_keys_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(material_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY,
      material_barcode TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      qty REAL NOT NULL,
      primary_qty REAL,
      uom TEXT,
      from_location_id TEXT,
      to_location_id TEXT,
      item_id INTEGER,
      variation_leaf_node_id INTEGER,
      reason_code TEXT,
      reference_type TEXT,
      reference_id TEXT,
      source_challan_id INTEGER,
      source_challan_type TEXT,
      source_challan_line_id INTEGER,
      reverses_movement_id TEXT,
      actor TEXT DEFAULT '',
      lot_code TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_barcode TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      reserved_qty REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS inventory_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_barcode TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      message TEXT NOT NULL DEFAULT '',
      is_open INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS inventory_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS inventory_set_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id INTEGER NOT NULL REFERENCES inventory_sets(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      variation_leaf_node_id INTEGER REFERENCES item_variation_nodes(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE(set_id, item_id, variation_leaf_node_id)
    )
  `);

  await run(
    'CREATE INDEX IF NOT EXISTS idx_inventory_set_lines_set_id ON inventory_set_lines(set_id)',
  );

  await run(
    'CREATE INDEX IF NOT EXISTS idx_inventory_set_lines_item_id ON inventory_set_lines(item_id)',
  );

  // Foreign key indexes for production scaling on materials
  await run('CREATE INDEX IF NOT EXISTS idx_materials_linked_group_id ON materials(linked_group_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_materials_linked_item_id ON materials(linked_item_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_materials_parent_barcode ON materials(parent_barcode)');

  // Indexes for health dashboard and inventory status filtering
  await run('CREATE INDEX IF NOT EXISTS idx_materials_inventory_state ON materials(inventory_state)');

  await run('CREATE INDEX IF NOT EXISTS idx_materials_stock_quantities ON materials(on_hand_qty, available_to_promise_qty, reserved_qty)');

  await run('CREATE INDEX IF NOT EXISTS idx_inventory_movements_health_query ON inventory_movements(movement_type, created_at)');

  await run('CREATE INDEX IF NOT EXISTS idx_inventory_alerts_is_open ON inventory_alerts(is_open)');

  // Inventory Sets indexes
  await run('CREATE INDEX IF NOT EXISTS idx_inventory_sets_name ON inventory_sets(name)');

  await run('CREATE INDEX IF NOT EXISTS idx_inventory_set_lines_item_lookup ON inventory_set_lines(item_id, variation_leaf_node_id)');

  await ensureColumnExists('materials', 'unit_id', 'INTEGER');

  await ensureColumnExists('materials', 'linked_group_id', 'INTEGER');

  await ensureColumnExists('materials', 'linked_item_id', 'INTEGER');

  await ensureColumnExists('materials', 'linked_variation_leaf_node_id', 'INTEGER');

  await run('CREATE INDEX IF NOT EXISTS idx_materials_item_variation_lookup ON materials(linked_item_id, linked_variation_leaf_node_id)');

  await ensureColumnExists('inventory_movements', 'primary_qty', 'REAL');

  await ensureColumnExists('inventory_movements', 'uom', 'TEXT');

  await ensureColumnExists('inventory_movements', 'item_id', 'INTEGER');

  await ensureColumnExists('inventory_movements', 'variation_leaf_node_id', 'INTEGER');

  await ensureColumnExists('inventory_movements', 'source_challan_id', 'INTEGER');

  await ensureColumnExists('inventory_movements', 'source_challan_type', 'TEXT');

  await ensureColumnExists('inventory_movements', 'source_challan_line_id', 'INTEGER');

  await ensureColumnExists('inventory_movements', 'reverses_movement_id', 'TEXT');

  await ensureColumnExists('inventory_movements', 'actor', "TEXT DEFAULT ''");

  await ensureColumnExists('inventory_movements', 'lot_code', "TEXT DEFAULT ''");

  await run('CREATE INDEX IF NOT EXISTS idx_inventory_movements_source_challan ON inventory_movements(source_challan_id, source_challan_type)');

  await ensureColumnExists('materials', 'location', "TEXT DEFAULT ''");

  await ensureColumnExists('materials', 'group_mode', 'TEXT');

  await ensureColumnExists(
    'materials',
    'inheritance_enabled',
    'INTEGER NOT NULL DEFAULT 0',
  );

  await ensureColumnExists('materials', 'display_stock', "TEXT DEFAULT ''");

  await ensureColumnExists('materials', 'created_by', "TEXT DEFAULT ''");

  await ensureColumnExists('materials', 'workflow_status', "TEXT DEFAULT 'notStarted'");

  await ensureColumnExists('materials', 'material_class', "TEXT DEFAULT 'raw_material'");

  await ensureColumnExists('materials', 'inventory_state', "TEXT DEFAULT 'available'");

  await ensureColumnExists('materials', 'procurement_state', "TEXT DEFAULT 'not_ordered'");

  await ensureColumnExists('materials', 'traceability_mode', "TEXT DEFAULT 'bulk'");

  await ensureColumnExists('materials', 'on_hand_qty', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('materials', 'reserved_qty', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('materials', 'available_to_promise_qty', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('materials', 'incoming_qty', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('materials', 'linked_order_count', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('materials', 'linked_pipeline_count', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('materials', 'pending_alert_count', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('materials', 'updated_at', 'TEXT');

  await ensureColumnExists('materials', 'last_scanned_at', 'TEXT');

  await ensureColumnExists(
    'material_group_properties',
    'coverage_count',
    'INTEGER NOT NULL DEFAULT 0',
  );

  await ensureColumnExists(
    'material_group_properties',
    'selected_item_count_at_resolution',
    'INTEGER NOT NULL DEFAULT 0',
  );

  await ensureColumnExists(
    'material_group_properties',
    'resolution_source',
    'TEXT',
  );

  await ensureColumnExists(
    'material_group_properties',
    'unit_id',
    'INTEGER',
  );

  await ensureColumnExists(
    'material_group_properties',
    'unit_symbol',
    'TEXT',
  );

  await ensureColumnExists(
    'material_group_properties',
    'unit_label',
    'TEXT',
  );

  await ensureColumnExists(
    'material_group_properties',
    'source_group_id',
    'INTEGER',
  );

  await ensureColumnExists(
    'material_group_properties',
    'source_group_name',
    'TEXT',
  );

  await ensureColumnExists(
    'material_group_preferences',
    'discarded_property_keys_json',
    "TEXT NOT NULL DEFAULT '[]'",
  );

  // --- Tables whose shape an older file may need rebuilt (moved 2026-11-19,
  // B37). Their rebuild, CREATE, columns and indexes run here in the order
  // they stood in initDb; triggers, data backfills and seeds stay there.
  await run(`
    CREATE TABLE IF NOT EXISTS inventory_stock_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_barcode TEXT NOT NULL,
      location_id TEXT NOT NULL DEFAULT 'MAIN',
      lot_code TEXT NOT NULL DEFAULT '',
      unit_id INTEGER,
      on_hand_qty REAL NOT NULL DEFAULT 0,
      reserved_qty REAL NOT NULL DEFAULT 0,
      damaged_qty REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(material_barcode, location_id, lot_code)
    )
  `);

  // A set can now also be *produced* rather than defined: an assembly step
  // clips parts together and mints a temporary set into inventory, the same way
  // a run mints a temporary item. These columns carry where it came from so the
  // Sets tab can show its origin, and so re-reconciling a stage updates the set
  // it already made instead of minting another.
  try { await run("ALTER TABLE inventory_sets ADD COLUMN origin_run_id TEXT"); } catch(e){}
  try { await run("ALTER TABLE inventory_sets ADD COLUMN origin_node_id TEXT"); } catch(e){}
  try { await run("ALTER TABLE inventory_sets ADD COLUMN source_set_id INTEGER REFERENCES inventory_sets(id)"); } catch(e){}
  try { await run("ALTER TABLE inventory_sets ADD COLUMN produced_at TEXT"); } catch(e){}
  try { await run("ALTER TABLE inventory_sets ADD COLUMN is_temporary INTEGER NOT NULL DEFAULT 0"); } catch(e){}
  // A produced set carries a materials row so it holds stock and keeps a ledger
  // like any other inventory line: in from production, out when it is issued.
  try { await run("ALTER TABLE materials ADD COLUMN linked_set_id INTEGER REFERENCES inventory_sets(id)"); } catch(e){}
  try {
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_sets_origin
               ON inventory_sets (origin_run_id, origin_node_id)
               WHERE origin_run_id IS NOT NULL AND origin_node_id IS NOT NULL`);
  } catch(e){}
  await run('CREATE INDEX IF NOT EXISTS idx_inventory_set_lines_set_id ON inventory_set_lines(set_id)');

  await ensureColumnExists('inventory_stock_positions', 'location_id', "TEXT NOT NULL DEFAULT 'MAIN'");
  await ensureColumnExists('inventory_stock_positions', 'lot_code', "TEXT NOT NULL DEFAULT ''");
  await ensureColumnExists('inventory_stock_positions', 'unit_id', 'INTEGER');
  await ensureColumnExists('inventory_stock_positions', 'reserved_qty', 'REAL NOT NULL DEFAULT 0');
  await ensureColumnExists('inventory_stock_positions', 'damaged_qty', 'REAL NOT NULL DEFAULT 0');
}

module.exports = { createSchema };
