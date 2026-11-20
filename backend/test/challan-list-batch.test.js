'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { makeTempDir } = require('./helpers/temp-dir');

// The challan list reads what its rows need once for the whole page (the
// line totals, the linked orders, the report groups, the files) instead of
// five times a row. Each row must still be exactly what the one-challan read
// gives — compared here for every challan, on a workspace whose challans have
// orders, a report group and a file.

test('every challan in the list is what the one-challan read gives', async () => {
  const tempDir = makeTempDir('paper-challan-batch-');
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'batch@paper.test';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';
  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData('scenario_c');

  const now = new Date().toISOString();
  const challans = await backend.all('SELECT id FROM delivery_challans ORDER BY id');
  assert.ok(challans.length >= 3, 'the scenario has challans to compare');
  const [first, second] = challans;
  // A report group, a second linked order, and two files, so every preloaded
  // piece has something in it.
  await backend.run("INSERT OR IGNORE INTO report_groups (code, label, created_at, updated_at) VALUES ('RG-BATCH', 'RG-BATCH', ?, ?)", [now, now]);
  await backend.run('INSERT OR IGNORE INTO delivery_challan_report_groups (challan_id, report_group_code, created_at) VALUES (?, ?, ?)', [first.id, 'RG-BATCH', now]);
  const order = await backend.get('SELECT id FROM order_items ORDER BY id DESC LIMIT 1');
  await backend.run('INSERT OR IGNORE INTO delivery_challan_order_items (challan_id, order_id, created_at) VALUES (?, ?, ?)', [second.id, order.id, now]);
  for (const [n, entityId] of [[1, first.id], [2, first.id], [3, second.id]]) {
    await backend.run(
      `INSERT INTO uploaded_assets (entity_type, entity_id, file_name, content_type, sha256, object_key, status, created_at)
       VALUES ('delivery_challan', ?, ?, 'image/png', ?, ?, 'uploaded', ?)`,
      [entityId, `photo-${n}.png`, `sha-${n}`, `challans/${entityId}/photo-${n}.png`, `2026-11-20T10:0${n}:00.000Z`],
    );
  }

  const listed = await backend.listDeliveryChallans({});
  assert.equal(listed.length, challans.length);
  for (const row of listed) {
    // The row the list query gives (it counts the lines into items_count).
    const dbRow = await backend.get(
      `SELECT dc.*, COUNT(dci.id) AS items_count FROM delivery_challans dc
       LEFT JOIN delivery_challan_items dci ON dci.challan_id = dc.id WHERE dc.id = ? GROUP BY dc.id`,
      [row.id],
    );
    const single = await backend.rowToDeliveryChallanDto(dbRow, { includeItems: false });
    // A signed file link carries the moment it was signed; that is the clock,
    // not the batching.
    const unsigned = (value) => JSON.parse(JSON.stringify(value, (key, v) =>
      (key === 'readUrlExpiresAt' || key === 'readUrl' || key === 'thumbUrl' ? undefined : v)));
    assert.deepEqual(unsigned(row), unsigned(single), `challan ${row.id} is the same either way`);
  }
  const withFiles = listed.find((row) => row.id === first.id);
  assert.ok(JSON.stringify(withFiles).includes('photo-2.png'), 'its files are there');
});
