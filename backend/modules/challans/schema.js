'use strict';

// ---------------------------------------------------------------------------
// The challans module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks. Tables this module
// owns that a rebuild in server.js still reshapes are not here yet.
//
//   challan_template_mappings
//   challan_template_upload_sessions
//   challan_templates
//   delivery_challan_activity_log
//   delivery_challan_items
//   delivery_challan_order_items
//   delivery_challan_report_groups
//   delivery_challans
//   invoice_headers
//   invoice_lines
//   reconciliation_conversion_overrides
//   reconciliation_waste_audit
//   report_groups
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all, get }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);
  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'delivery',
      order_id INTEGER REFERENCES order_items(id),
      order_no TEXT DEFAULT '',
      challan_no TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      location TEXT DEFAULT 'MAIN',
      customer_name TEXT NOT NULL DEFAULT '',
      customer_gstin TEXT DEFAULT '',
      vendor_id INTEGER REFERENCES vendors(id),
      vendor_name TEXT DEFAULT '',
      vendor_gstin TEXT DEFAULT '',
      material_owner_client_id INTEGER REFERENCES clients(id),
      material_owner_client_name TEXT DEFAULT '',
      material_owner_gstin TEXT DEFAULT '',
      source_reference TEXT DEFAULT '',
      company_profile_snapshot TEXT,
      template_snapshot_json TEXT,
      notes TEXT DEFAULT '',
      maintain_stocks INTEGER NOT NULL DEFAULT 1,
      used_in_report INTEGER NOT NULL DEFAULT 0,
      purpose TEXT NOT NULL DEFAULT 'trading',
      status TEXT NOT NULL DEFAULT 'draft',
      created_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challan_id INTEGER NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
      order_item_id INTEGER,
      production_run_id INTEGER,
      item_id INTEGER,
      variation_leaf_node_id INTEGER NOT NULL DEFAULT 0,
      line_no INTEGER NOT NULL DEFAULT 1,
      particulars TEXT NOT NULL DEFAULT '',
      hsn_code TEXT DEFAULT '',
      variation_path_label TEXT DEFAULT '',
      variation_path_node_ids_json TEXT NOT NULL DEFAULT '[]',
      custom_variation_values_json TEXT DEFAULT '{}',
      note TEXT DEFAULT '',
      quantity_pcs REAL NOT NULL DEFAULT 0,
      weight REAL NOT NULL DEFAULT 0,
      sheet_weights_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challan_order_items (
      challan_id INTEGER NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (challan_id, order_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS report_groups (
      code TEXT PRIMARY KEY,
      label TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challan_report_groups (
      challan_id INTEGER NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
      report_group_code TEXT NOT NULL REFERENCES report_groups(code) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (challan_id, report_group_code)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challan_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challan_id INTEGER NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL,
      actor_user_id INTEGER,
      actor_name TEXT,
      actor_role TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS challan_template_upload_sessions (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL,
      upload_type TEXT NOT NULL DEFAULT 'CHALLAN_TEMPLATE_BACKGROUND',
      object_key TEXT NOT NULL,
      canvas_width INTEGER NOT NULL DEFAULT 0,
      canvas_height INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS challan_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      party_type TEXT NOT NULL,
      party_id INTEGER NOT NULL,
      challan_type TEXT NOT NULL,
      background_object_key TEXT NOT NULL,
      canvas_width INTEGER NOT NULL,
      canvas_height INTEGER NOT NULL,
      rotation_degrees REAL NOT NULL DEFAULT 0,
      global_offset_x_mm REAL NOT NULL DEFAULT 0,
      global_offset_y_mm REAL NOT NULL DEFAULT 0,
      stock_size TEXT NOT NULL DEFAULT 'A4',
      paper_size TEXT NOT NULL DEFAULT 'A4',
      n_up_layout INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS challan_template_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES challan_templates(id) ON DELETE CASCADE,
      field_type TEXT NOT NULL DEFAULT 'DYNAMIC',
      field_key TEXT NOT NULL,
      field_value TEXT NOT NULL DEFAULT '',
      asset_object_key TEXT NOT NULL DEFAULT '',
      asset_width_px INTEGER NOT NULL DEFAULT 0,
      asset_height_px INTEGER NOT NULL DEFAULT 0,
      width_mm REAL NOT NULL DEFAULT 80,
      height_mm REAL NOT NULL DEFAULT 12,
      image_width_mm REAL NOT NULL DEFAULT 35,
      image_height_mm REAL NOT NULL DEFAULT 20,
      lock_aspect_ratio INTEGER NOT NULL DEFAULT 1,
      x_mm REAL NOT NULL DEFAULT 0,
      y_mm REAL NOT NULL DEFAULT 0,
      x_percent REAL NOT NULL,
      y_percent REAL NOT NULL,
      font_size REAL NOT NULL DEFAULT 10,
      font_weight TEXT NOT NULL DEFAULT 'normal',
      alignment TEXT NOT NULL DEFAULT 'left',
      text_color TEXT NOT NULL DEFAULT 'black',
      letter_spacing REAL NOT NULL DEFAULT 0,
      max_chars INTEGER NOT NULL DEFAULT 0,
      max_width_mm REAL NOT NULL DEFAULT 80,
      min_font_size REAL NOT NULL DEFAULT 6,
      min_rows INTEGER NOT NULL DEFAULT 0,
      max_rows INTEGER NOT NULL DEFAULT 0,
      table_height_mm REAL NOT NULL DEFAULT 60,
      row_height_mm REAL NOT NULL DEFAULT 6,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(template_id, field_key)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challans_status ON delivery_challans(status)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challans_date ON delivery_challans(date)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_challan_id ON delivery_challan_items(challan_id)');

  // order_item_id is joined on by the fulfilment rollup and the delivered
  // totals, and was previously unindexed.
  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_order_item_id ON delivery_challan_items(order_item_id)');
  // The item list counts each part's challan lines; without this every count
  // scanned the table, once per part (Docs/benchmarks/2026-11-constrained-network-results.md).
  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_item_id ON delivery_challan_items(item_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_orders_challan_id ON delivery_challan_order_items(challan_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_orders_order_id ON delivery_challan_order_items(order_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_report_groups_challan_id ON delivery_challan_report_groups(challan_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_report_groups_code ON delivery_challan_report_groups(report_group_code)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_activity_challan_id_created_at ON delivery_challan_activity_log(challan_id, created_at)');

  await run('CREATE INDEX IF NOT EXISTS idx_challan_template_upload_sessions_sha256 ON challan_template_upload_sessions(sha256)');

  await run('CREATE INDEX IF NOT EXISTS idx_challan_templates_party ON challan_templates(party_type, party_id, challan_type, is_active)');

  await run('CREATE INDEX IF NOT EXISTS idx_challan_template_mappings_template_id ON challan_template_mappings(template_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS invoice_headers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT NOT NULL UNIQUE,
      client_id INTEGER REFERENCES clients(id),
      client_name TEXT NOT NULL DEFAULT '',
      gstin TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      invoice_date TEXT NOT NULL,
      total_quantity REAL NOT NULL DEFAULT 0,
      taxable_value REAL NOT NULL DEFAULT 0,
      cgst_amount REAL NOT NULL DEFAULT 0,
      sgst_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS invoice_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoice_headers(id) ON DELETE CASCADE,
      order_id INTEGER,
      challan_id INTEGER REFERENCES delivery_challans(id),
      challan_item_id INTEGER REFERENCES delivery_challan_items(id),
      item_id INTEGER,
      variation_leaf_node_id INTEGER NOT NULL DEFAULT 0,
      item_name TEXT NOT NULL DEFAULT '',
      hsn_code TEXT DEFAULT '',
      quantity REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      taxable_value REAL NOT NULL DEFAULT 0,
      cgst_rate REAL NOT NULL DEFAULT 0,
      sgst_rate REAL NOT NULL DEFAULT 0,
      cgst_amount REAL NOT NULL DEFAULT 0,
      sgst_amount REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS reconciliation_conversion_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      variation_leaf_node_id INTEGER NOT NULL DEFAULT 0,
      conversion_ratio REAL NOT NULL DEFAULT 1,
      from_unit TEXT NOT NULL DEFAULT 'kg',
      to_unit_label TEXT NOT NULL DEFAULT 'units',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(item_id, variation_leaf_node_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS reconciliation_waste_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      client_name TEXT NOT NULL DEFAULT '',
      item_id INTEGER,
      variation_leaf_node_id INTEGER NOT NULL DEFAULT 0,
      item_name TEXT NOT NULL DEFAULT '',
      challan_id INTEGER REFERENCES delivery_challans(id),
      challan_no TEXT DEFAULT '',
      input_weight_kg REAL NOT NULL DEFAULT 0,
      shipped_weight_kg REAL NOT NULL DEFAULT 0,
      waste_weight_kg REAL NOT NULL DEFAULT 0,
      waste_percentage REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'report_snapshot',
      created_at TEXT NOT NULL
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice_id ON invoice_lines(invoice_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_invoice_lines_challan_item ON invoice_lines(challan_item_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_invoice_lines_order_id ON invoice_lines(order_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_reconciliation_conversion_item ON reconciliation_conversion_overrides(item_id, variation_leaf_node_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_reconciliation_waste_client_item ON reconciliation_waste_audit(client_id, item_id, variation_leaf_node_id)');

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id),
      order_no TEXT DEFAULT '',
      challan_no TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      customer_gstin TEXT DEFAULT '',
      company_profile_snapshot TEXT,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      created_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challan_id INTEGER NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
      order_item_id INTEGER,
      item_id INTEGER,
      line_no INTEGER NOT NULL DEFAULT 1,
      particulars TEXT NOT NULL DEFAULT '',
      hsn_code TEXT DEFAULT '',
      variation_path_label TEXT DEFAULT '',
      variation_path_node_ids_json TEXT NOT NULL DEFAULT '[]',
      note TEXT DEFAULT '',
      custom_variation_values_json TEXT DEFAULT '{}',
      quantity_pcs TEXT DEFAULT '',
      weight TEXT DEFAULT '',
      sheet_weights_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challan_activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challan_id INTEGER NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL,
      actor_user_id INTEGER,
      actor_name TEXT,
      actor_role TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await ensureColumnExists('delivery_challans', 'order_id', 'INTEGER');

  await ensureColumnExists('delivery_challans', 'order_no', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challans', 'type', "TEXT NOT NULL DEFAULT 'delivery'");

  await ensureColumnExists('delivery_challans', 'location', "TEXT DEFAULT 'MAIN'");

  await ensureColumnExists('delivery_challans', 'vendor_id', 'INTEGER');

  await ensureColumnExists('delivery_challans', 'vendor_name', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challans', 'vendor_gstin', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challans', 'material_owner_client_id', 'INTEGER');

  await ensureColumnExists('delivery_challans', 'material_owner_client_name', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challans', 'material_owner_gstin', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challans', 'source_reference', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challans', 'po_number', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challans', 'po_date', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challans', 'template_snapshot_json', 'TEXT');

  await ensureColumnExists('delivery_challans', 'maintain_stocks', 'INTEGER NOT NULL DEFAULT 1');

  await ensureColumnExists('delivery_challans', 'used_in_report', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('delivery_challans', 'purpose', "TEXT NOT NULL DEFAULT 'trading'");

  // Internal challans — free-text purpose (production consumption / transfers).
  await ensureColumnExists('delivery_challans', 'internal_purpose', "TEXT NOT NULL DEFAULT ''");

  // Reconciliation of an internal-use challan: JSON breakdown of each consumed
  // line settled across scrap/leftover/lost/rejection/finished-goods. Empty
  // until the mobile In-use reconciliation flow settles the challan.
  await ensureColumnExists('delivery_challans', 'reconciliation_json', "TEXT NOT NULL DEFAULT ''");

  // Structured internal-challan subtype (e.g. 'vendor_return') — replaces
  // string-matching the free-text internal_purpose.
  await ensureColumnExists('delivery_challans', 'internal_subtype', "TEXT NOT NULL DEFAULT ''");

  // Vendor-return challans carry the scanned sheet tag codes so issuing can mark
  // those piece_barcodes returned (and reject a double return).
  await ensureColumnExists('delivery_challans', 'returned_sheet_codes_json', "TEXT NOT NULL DEFAULT '[]'");

  // The reception a vendor return sends stock back from, when the return was
  // made by cancelling a partly used reception.
  await ensureColumnExists('delivery_challans', 'source_reception_challan_id', 'INTEGER');

  await ensureColumnExists('delivery_challan_items', 'material_barcode', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challan_items', 'order_item_id', 'INTEGER');

  await ensureColumnExists('delivery_challan_items', 'production_run_id', 'INTEGER');

  await ensureColumnExists('delivery_challan_items', 'item_id', 'INTEGER');

  await ensureColumnExists('delivery_challan_items', 'variation_leaf_node_id', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('delivery_challan_items', 'variation_path_label', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challan_items', 'variation_path_node_ids_json', "TEXT NOT NULL DEFAULT '[]'");

  await ensureColumnExists('delivery_challan_items', 'note', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challan_items', 'production_run_id', 'INTEGER');

  await ensureColumnExists('delivery_challan_items', 'variation_leaf_node_id', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('delivery_challan_items', 'variation_path_label', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challan_items', 'variation_path_node_ids_json', "TEXT NOT NULL DEFAULT '[]'");

  await ensureColumnExists('delivery_challan_items', 'note', "TEXT DEFAULT ''");

  await ensureColumnExists('delivery_challan_items', 'custom_variation_values_json', "TEXT DEFAULT '{}'");

  // Per-sheet weight breakdown for purchase intake: JSON array of numbers, one
  // per received sheet, summing to the line weight (total-in = total-out).
  await ensureColumnExists('delivery_challan_items', 'sheet_weights_json', "TEXT NOT NULL DEFAULT '[]'");

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challan_order_items (
      challan_id INTEGER NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (challan_id, order_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS report_groups (
      code TEXT PRIMARY KEY,
      label TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_challan_report_groups (
      challan_id INTEGER NOT NULL REFERENCES delivery_challans(id) ON DELETE CASCADE,
      report_group_code TEXT NOT NULL REFERENCES report_groups(code) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (challan_id, report_group_code)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challans_order_id ON delivery_challans(order_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challans_vendor_id ON delivery_challans(vendor_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challans_material_owner ON delivery_challans(material_owner_client_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challans_type ON delivery_challans(type)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_challan_id ON delivery_challan_items(challan_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_orders_challan_id ON delivery_challan_order_items(challan_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_orders_order_id ON delivery_challan_order_items(order_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_report_groups_challan_id ON delivery_challan_report_groups(challan_id)');

  await run('CREATE INDEX IF NOT EXISTS idx_delivery_challan_report_groups_code ON delivery_challan_report_groups(report_group_code)');

  await ensureColumnExists('challan_templates', 'rotation_degrees', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_templates', 'global_offset_x_mm', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_templates', 'global_offset_y_mm', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_templates', 'stock_size', "TEXT NOT NULL DEFAULT 'A4'");

  await ensureColumnExists('challan_templates', 'paper_size', "TEXT NOT NULL DEFAULT 'A4'");

  await ensureColumnExists('challan_templates', 'n_up_layout', 'INTEGER NOT NULL DEFAULT 1');

  await ensureColumnExists('challan_templates', 'is_active', 'INTEGER NOT NULL DEFAULT 1');

  await ensureColumnExists('challan_template_upload_sessions', 'upload_type', "TEXT NOT NULL DEFAULT 'CHALLAN_TEMPLATE_BACKGROUND'");

  await ensureColumnExists('challan_template_upload_sessions', 'canvas_width', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_template_upload_sessions', 'canvas_height', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_template_mappings', 'field_type', "TEXT NOT NULL DEFAULT 'DYNAMIC'");

  await ensureColumnExists('challan_template_mappings', 'field_value', "TEXT NOT NULL DEFAULT ''");

  await ensureColumnExists('challan_template_mappings', 'asset_object_key', "TEXT NOT NULL DEFAULT ''");

  await ensureColumnExists('challan_template_mappings', 'asset_width_px', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_template_mappings', 'asset_height_px', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_template_mappings', 'width_mm', 'REAL NOT NULL DEFAULT 80');

  await ensureColumnExists('challan_template_mappings', 'height_mm', 'REAL NOT NULL DEFAULT 12');

  await ensureColumnExists('challan_template_mappings', 'image_width_mm', 'REAL NOT NULL DEFAULT 35');

  await ensureColumnExists('challan_template_mappings', 'image_height_mm', 'REAL NOT NULL DEFAULT 20');

  await ensureColumnExists('challan_template_mappings', 'lock_aspect_ratio', 'INTEGER NOT NULL DEFAULT 1');

  await ensureColumnExists('challan_template_mappings', 'x_mm', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_template_mappings', 'y_mm', 'REAL NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_template_mappings', 'text_color', "TEXT NOT NULL DEFAULT 'black'");

  await ensureColumnExists('challan_template_mappings', 'max_width_mm', 'REAL NOT NULL DEFAULT 80');

  await ensureColumnExists('challan_template_mappings', 'min_font_size', 'REAL NOT NULL DEFAULT 6');

  await ensureColumnExists('challan_template_mappings', 'min_rows', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_template_mappings', 'max_rows', 'INTEGER NOT NULL DEFAULT 0');

  await ensureColumnExists('challan_template_mappings', 'table_height_mm', 'REAL NOT NULL DEFAULT 60');

  await run('CREATE INDEX IF NOT EXISTS idx_challan_templates_party ON challan_templates(party_type, party_id, challan_type, is_active)');

  await run('CREATE INDEX IF NOT EXISTS idx_challan_template_mappings_template_id ON challan_template_mappings(template_id)');

  await ensureColumnExists('delivery_challan_items', 'factor_to_primary_at_creation', 'REAL NOT NULL DEFAULT 1');

  // --- Tables whose shape an older file may need rebuilt (moved 2026-11-19,
  // B37). Their rebuild, CREATE, columns and indexes run here in the order
  // they stood in initDb; triggers, data backfills and seeds stay there.
  await run(`
    CREATE TABLE IF NOT EXISTS piece_barcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challan_item_id INTEGER NOT NULL REFERENCES delivery_challan_items(id) ON DELETE CASCADE,
      parent_code TEXT UNIQUE NOT NULL,
      child_code TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  await run('CREATE INDEX IF NOT EXISTS idx_piece_barcodes_parent_code ON piece_barcodes(parent_code)');
  await run('CREATE INDEX IF NOT EXISTS idx_piece_barcodes_child_code ON piece_barcodes(child_code)');
  await run('CREATE INDEX IF NOT EXISTS idx_piece_barcodes_challan_item_id ON piece_barcodes(challan_item_id)');
  // Per-sheet weight printed on each barcode tag (added after initial release).
  await ensureColumnExists('piece_barcodes', 'weight', 'REAL NOT NULL DEFAULT 0');
  // Vendor-return tracking: stamped when the sheet is returned to its vendor so a
  // sheet cannot be returned twice.
  await ensureColumnExists('piece_barcodes', 'returned_at', 'TEXT');
  await ensureColumnExists('piece_barcodes', 'returned_challan_id', 'INTEGER');
}

module.exports = { createSchema };
