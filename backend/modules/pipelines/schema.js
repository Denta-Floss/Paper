'use strict';

// ---------------------------------------------------------------------------
// The pipelines module's tables, as initDb in server.js created them until
// 2026-11-19: the same statements, in the same order, moved here whole.
// `ensureColumnExists` adds a column an older file lacks.
// ---------------------------------------------------------------------------

const { ensureColumnExists: ensureColumn } = require('../../kernel/schema-kit');

async function createSchema({ run, all, get }) {
  const ensureColumnExists = (table, column, definition) => ensureColumn({ run, all }, table, column, definition);

  // --- Tables whose shape an older file may need rebuilt (moved 2026-11-19,
  // B37). Their rebuild, CREATE, columns and indexes run here in the order
  // they stood in initDb; triggers, data backfills and seeds stay there.
  await run(`
    CREATE TABLE IF NOT EXISTS pipeline_templates (
      id TEXT PRIMARY KEY,
      factory_id TEXT DEFAULT '',
      shop_floor_id TEXT DEFAULT '',
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT DEFAULT 'draft',
      stage_labels_json TEXT NOT NULL,
      lane_labels_json TEXT NOT NULL,
      nodes_json TEXT NOT NULL,
      flows_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await ensureColumnExists('pipeline_templates', 'factory_id', "TEXT DEFAULT ''");
  await ensureColumnExists('pipeline_templates', 'shop_floor_id', "TEXT DEFAULT ''");
  await ensureColumnExists('pipeline_templates', 'intermediate_naming_convention', "TEXT DEFAULT ''");
  await ensureColumnExists('pipeline_templates', 'pen_paper_baseline_json', "TEXT DEFAULT '{}'");
}

module.exports = { createSchema };
