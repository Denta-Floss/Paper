'use strict';

// ---------------------------------------------------------------------------
// The orders module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   order_activity_log
//   order_headers
//   order_items
//   order_material_requirements
//   order_po_documents
//   order_returns
//   order_status_history
//   po_documents
//   po_upload_sessions
//   procurement_activity_log
//   procurement_request_line_sources
//   procurement_request_lines
//   procurement_requests
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS order_headers (
      order_no TEXT PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      sub_contractor_id INTEGER REFERENCES sub_contractors(id),
      po_number TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL REFERENCES order_headers(order_no),
      client_id INTEGER NOT NULL REFERENCES clients(id),
      sub_contractor_id INTEGER REFERENCES sub_contractors(id),
      client_name TEXT NOT NULL DEFAULT '',
      po_number TEXT DEFAULT '',
      client_code TEXT DEFAULT '',
      item_id INTEGER NOT NULL REFERENCES items(id),
      item_name TEXT NOT NULL DEFAULT '',
      variation_leaf_node_id INTEGER NOT NULL DEFAULT 0,
      variation_path_label TEXT DEFAULT '',
      variation_path_node_ids_json TEXT NOT NULL DEFAULT '[]',
      custom_variation_values_json TEXT DEFAULT '{}',
      quantity INTEGER NOT NULL DEFAULT 0,
      unit_id INTEGER REFERENCES units(id),
      unit_name TEXT NOT NULL DEFAULT 'Pieces',
      unit_symbol TEXT NOT NULL DEFAULT 'Pieces',
      unit_price REAL NOT NULL DEFAULT 0,
      total_invoiced_qty REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'notStarted',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
      start_date TEXT,
      end_date TEXT,
      hsn_code TEXT DEFAULT '',
      taxable_value REAL DEFAULT 0,
      cgst_rate REAL DEFAULT 0,
      sgst_rate REAL DEFAULT 0,
      cgst_amount REAL DEFAULT 0,
      sgst_amount REAL DEFAULT 0
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS po_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL UNIQUE,
      object_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'uploaded',
      created_at TEXT NOT NULL,
      uploaded_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS po_upload_sessions (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      object_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS order_po_documents (
      order_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      document_id INTEGER NOT NULL REFERENCES po_documents(id) ON DELETE CASCADE,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (order_id, document_id)
    )
  `);

  await run(
    'CREATE INDEX IF NOT EXISTS idx_order_po_documents_order_id ON order_po_documents(order_id)',
  );

  await run(
    'CREATE INDEX IF NOT EXISTS idx_po_upload_sessions_sha256 ON po_upload_sessions(sha256)',
  );

  await run(`
    CREATE TABLE IF NOT EXISTS order_material_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      item_id INTEGER,
      variation_leaf_node_id INTEGER,
      material_id INTEGER,
      material_barcode TEXT,
      material_name TEXT,
      required_qty REAL NOT NULL DEFAULT 0,
      allocated_qty REAL NOT NULL DEFAULT 0,
      consumed_qty REAL NOT NULL DEFAULT 0,
      shortage_qty REAL NOT NULL DEFAULT 0,
      unit_id INTEGER,
      unit_symbol TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS order_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      changed_by_user_id INTEGER,
      changed_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS order_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL,
      actor_user_id INTEGER,
      actor_name TEXT,
      actor_role TEXT,
      source TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_order_material_requirements_order_id ON order_material_requirements(order_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_order_material_requirements_material_barcode ON order_material_requirements(material_barcode)');

  await run('CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id_changed_at ON order_status_history(order_id, changed_at)');

  await run('CREATE INDEX IF NOT EXISTS idx_order_activity_log_order_id_created_at ON order_activity_log(order_id, created_at)');

  // --- Column migrations for order_activity_log on pre-existing databases ---
  // The CREATE TABLE above is skipped if the table already exists. These
  // ensureColumnExists calls add any missing columns added in later versions.
  await ensureColumnExists('order_activity_log', 'activity_type', "TEXT NOT NULL DEFAULT ''");

  await ensureColumnExists('order_activity_log', 'actor_user_id', 'INTEGER');

  await ensureColumnExists('order_activity_log', 'actor_name', 'TEXT');

  await ensureColumnExists('order_activity_log', 'actor_role', 'TEXT');

  await ensureColumnExists('order_activity_log', 'source', 'TEXT');

  await ensureColumnExists('order_activity_log', 'details_json', 'TEXT');

  await ensureColumnExists('order_items', 'updated_at', "TEXT NOT NULL DEFAULT ''");

  await ensureColumnExists('order_items', 'unit_id', 'INTEGER');

  await ensureColumnExists('order_items', 'unit_name', "TEXT NOT NULL DEFAULT 'Pieces'");

  await ensureColumnExists('order_items', 'unit_symbol', "TEXT NOT NULL DEFAULT 'Pieces'");

  await ensureColumnExists('order_items', 'unit_price', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('order_items', 'custom_variation_values_json', "TEXT DEFAULT '{}'");

  await ensureColumnExists(
    'order_items',
    'total_invoiced_qty',
    'REAL NOT NULL DEFAULT 0',
  );

  await ensureColumnExists('order_items', 'hsn_code', "TEXT DEFAULT ''");

  await ensureColumnExists('order_items', 'taxable_value', 'REAL DEFAULT 0');

  await ensureColumnExists('order_items', 'cgst_rate', 'REAL DEFAULT 0');

  await ensureColumnExists('order_items', 'sgst_rate', 'REAL DEFAULT 0');

  await ensureColumnExists('order_items', 'cgst_amount', 'REAL DEFAULT 0');

  await ensureColumnExists('order_items', 'sgst_amount', 'REAL DEFAULT 0');

  await ensureColumnExists('order_items', 'factor_to_primary_at_creation', 'REAL NOT NULL DEFAULT 1');

  // Which set this line was expanded from, snapshotted at order time. Dead
  // labels, never a live reference: editing the set must not reach back and
  // change what was agreed. See saveOrder / _addLinesFromSet.
  await ensureColumnExists('order_items', 'source_set_id', 'INTEGER');

  await ensureColumnExists('order_items', 'source_set_name', "TEXT NOT NULL DEFAULT ''");

  await ensureColumnExists('order_items', 'source_set_multiplier', 'INTEGER NOT NULL DEFAULT 0');

  await run(`
    CREATE TABLE IF NOT EXISTS order_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_no TEXT NOT NULL UNIQUE,
      order_no TEXT NOT NULL REFERENCES order_headers(order_no),
      order_item_id INTEGER REFERENCES order_items(id),
      quantity REAL NOT NULL DEFAULT 0,
      unit TEXT DEFAULT 'pcs',
      reason_code TEXT NOT NULL DEFAULT 'defect',
      defect_description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      returned_barcode TEXT DEFAULT '',
      pipeline_run_id TEXT REFERENCES pipeline_runs(id),
      logged_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_order_returns_order_no ON order_returns(order_no)');

  await run('CREATE INDEX IF NOT EXISTS idx_order_returns_status ON order_returns(status)');

  await run(`
    CREATE TABLE IF NOT EXISTS procurement_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_number TEXT NOT NULL UNIQUE,
      supplier_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      expected_date TEXT,
      notes TEXT DEFAULT '',
      cancel_reason TEXT,
      created_by_user_id INTEGER REFERENCES users(id),
      created_by_name TEXT DEFAULT '',
      created_by_role TEXT DEFAULT '',
      raised_by_user_id INTEGER REFERENCES users(id),
      raised_by_name TEXT DEFAULT '',
      raised_by_role TEXT DEFAULT '',
      cancelled_by_user_id INTEGER REFERENCES users(id),
      cancelled_by_name TEXT DEFAULT '',
      cancelled_by_role TEXT DEFAULT '',
      closed_by_user_id INTEGER REFERENCES users(id),
      closed_by_name TEXT DEFAULT '',
      closed_by_role TEXT DEFAULT '',
      raised_at TEXT,
      cancelled_at TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS procurement_request_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procurement_request_id INTEGER NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
      material_barcode TEXT NOT NULL,
      material_name TEXT DEFAULT '',
      requested_qty REAL NOT NULL DEFAULT 0,
      received_qty REAL NOT NULL DEFAULT 0,
      pending_qty REAL NOT NULL DEFAULT 0,
      unit_id INTEGER REFERENCES units(id),
      unit_symbol TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      custom_variation_values_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(procurement_request_id, material_barcode)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS procurement_request_line_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procurement_request_id INTEGER NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
      procurement_request_line_id INTEGER NOT NULL REFERENCES procurement_request_lines(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      requirement_id INTEGER NOT NULL REFERENCES order_material_requirements(id) ON DELETE CASCADE,
      material_barcode TEXT NOT NULL,
      linked_qty REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(procurement_request_line_id, requirement_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS procurement_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procurement_request_id INTEGER NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
      procurement_request_line_id INTEGER REFERENCES procurement_request_lines(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      actor_user_id INTEGER REFERENCES users(id),
      actor_name TEXT DEFAULT '',
      actor_role TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}',
      source TEXT DEFAULT 'api',
      created_at TEXT NOT NULL
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_procurement_requests_status ON procurement_requests(status, updated_at DESC)');

  await run('CREATE INDEX IF NOT EXISTS idx_procurement_request_lines_request_id ON procurement_request_lines(procurement_request_id, id ASC)');

  await run('CREATE INDEX IF NOT EXISTS idx_procurement_line_sources_requirement_id ON procurement_request_line_sources(requirement_id, id ASC)');

  await run('CREATE INDEX IF NOT EXISTS idx_procurement_line_sources_request_id ON procurement_request_line_sources(procurement_request_id, id ASC)');

  await run('CREATE INDEX IF NOT EXISTS idx_procurement_activity_request_id ON procurement_activity_log(procurement_request_id, created_at DESC)');
}

module.exports = { createSchema };
