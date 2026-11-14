const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// A brand-new install: no database file at all.
//
// startServer runs migrate.js's runner and THEN initDb. On an empty database
// the first migration that alters a table (007, order_items) found no table,
// the runner rejected, and the server came up answering every request with
// "Database initialization failed: no such table: order_items". Every other
// test reaches the schema through resetAndSeedDemoData, which never takes that
// path, so nothing noticed.

test('a server with no database file comes up with the whole schema', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-empty-boot-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'empty@example.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  for (const mod of ['../server.js', '../migrate.js']) {
    delete require.cache[require.resolve(mod)];
  }
  const { runMigrations } = require('../migrate.js');
  const backend = require('../server.js');

  // The same two steps, in the same order, as startServer.
  await runMigrations();
  await backend.initDb();

  const columns = (await backend.all('PRAGMA table_info(order_items)')).map((c) => c.name);
  assert.ok(columns.length > 0, 'order_items exists');
  assert.ok(
    columns.includes('custom_variation_values_json'),
    'and the column migration 007 adds is there, from the post-schema run',
  );
  // Something only a migration creates, to show the post-schema run did happen.
  const portal = await backend.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portal_users'");
  assert.ok(portal, 'a migration-only table exists');

  // A second boot over the now-populated database is a no-op, not an error.
  await runMigrations();
  await backend.initDb();
  await backend.closeDb();
});
