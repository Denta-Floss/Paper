'use strict';

// ---------------------------------------------------------------------------
// The jobs module's tables, as initDb in server.js created them until
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
    CREATE TABLE IF NOT EXISTS freelancer_job_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      freelancer_id INTEGER REFERENCES employees(id),
      batch_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'assigned',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS freelancer_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES freelancer_job_batches(id) ON DELETE SET NULL,
      item_id INTEGER REFERENCES items(id),
      variation_leaf_node_id INTEGER NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      payout_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  try { await run("ALTER TABLE freelancer_jobs ADD COLUMN batch_id INTEGER REFERENCES freelancer_job_batches(id) ON DELETE SET NULL"); } catch(e){}
  try { await run("ALTER TABLE freelancer_jobs ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1"); } catch(e){}

  // Origin of an auto-created Assembly job. Both NULL for jobs raised by hand,
  // so the partial index below only constrains the generated ones.
  // run_id is TEXT to match pipeline_runs.id, which is a TEXT primary key.
  try { await run("ALTER TABLE freelancer_jobs ADD COLUMN run_id TEXT REFERENCES pipeline_runs(id) ON DELETE CASCADE"); } catch(e){}
  try { await run("ALTER TABLE freelancer_jobs ADD COLUMN node_id TEXT"); } catch(e){}
  // What the assembler rejected off this job. On an assembly step the pieces
  // that come off the line are not scrap — nothing was machined — they are
  // rejections, and the count belongs on the worker's job card.
  try { await run("ALTER TABLE freelancer_jobs ADD COLUMN rejected_quantity REAL NOT NULL DEFAULT 0"); } catch(e){}
  try { await run("ALTER TABLE freelancer_jobs ADD COLUMN rejection_note TEXT NOT NULL DEFAULT ''"); } catch(e){}

  // One job per (run, assembly node) — the status of a node can be re-set any
  // number of times and must not fan out into duplicate jobs.
  try {
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_freelancer_jobs_run_node
               ON freelancer_jobs (run_id, node_id)
               WHERE run_id IS NOT NULL AND node_id IS NOT NULL`);
  } catch(e){}


  await run(`
    CREATE TABLE IF NOT EXISTS freelancer_job_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES freelancer_jobs(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      variation_leaf_node_id INTEGER NOT NULL DEFAULT 0,
      required_quantity REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

module.exports = { createSchema };
