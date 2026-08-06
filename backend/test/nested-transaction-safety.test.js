const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// SQLite has no nested transactions. A helper that unconditionally opens one
// cannot be called from inside a caller's transaction — the BEGIN throws
// "cannot start a transaction within a transaction" and takes the caller's
// whole unit of work down with it.
//
// This bit in-use challan reconciliation: handleReconcileChallan opens a
// transaction, then ensureReconcileItem -> saveItem opened a second one, so
// settling a challan into any bucket that needed a NEW return item failed
// outright. (The file even carries a comment noting SQLite's limitation for
// updateOrderLifecycle — this path was simply missed.)

test('saveItem can join a caller transaction instead of opening its own', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-nested-tx-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'tx-owner@paper.local';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';

  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();

  try {
    const group = await backend.get(
      'SELECT id, unit_id FROM groups WHERE unit_id IS NOT NULL AND is_archived = 0 LIMIT 1',
    );
    assert.ok(group, 'expected a seeded group with a unit');

    // The failing shape: a caller already holds a transaction.
    await backend.run('BEGIN TRANSACTION');
    let created = null;
    try {
      created = await backend.saveItem(
        {
          name: 'Nested Tx Item',
          alias: '',
          displayName: 'Nested Tx Item',
          quantity: 0,
          groupId: group.id,
          unitId: group.unit_id,
        },
        { useTransaction: false },
      );
      await backend.run('COMMIT');
    } catch (error) {
      await backend.run('ROLLBACK');
      throw error;
    }

    assert.ok(created && created.id, 'item must be created inside the caller transaction');
    const persisted = await backend.get('SELECT id FROM items WHERE name = ?', ['Nested Tx Item']);
    assert.ok(persisted, 'the committed caller transaction must include the new item');

    // And the default still manages its own transaction for ordinary callers.
    const standalone = await backend.saveItem({
      name: 'Standalone Tx Item',
      alias: '',
      displayName: 'Standalone Tx Item',
      quantity: 0,
      groupId: group.id,
      unitId: group.unit_id,
    });
    assert.ok(standalone && standalone.id, 'default path must still work unchanged');
  } finally {
    await backend.closeDb?.();
  }
});

test('reconcile helpers never open a transaction of their own', async () => {
  // Static guard: these three run inside handleReconcileChallan's transaction.
  // If any of them (or anything they call unconditionally) opens a BEGIN, the
  // reconciliation dies. saveGroup is transaction-free; saveItem is now opt-in.
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  const reconcileItem = source.slice(
    source.indexOf('async function ensureReconcileItem'),
    source.indexOf('async function ensureKgUnit'),
  );
  assert.ok(reconcileItem.length > 0, 'expected to find ensureReconcileItem');
  assert.match(
    reconcileItem,
    /useTransaction:\s*false/,
    'ensureReconcileItem must call saveItem with useTransaction: false',
  );

  const saveGroupStart = source.indexOf('async function saveGroup');
  const saveGroupBody = source.slice(saveGroupStart, saveGroupStart + 9000);
  const bodyUntilNextFn = saveGroupBody.slice(
    0,
    saveGroupBody.indexOf('\nasync function ', 10),
  );
  assert.ok(
    !/BEGIN TRANSACTION/.test(bodyUntilNextFn),
    'saveGroup must stay transaction-free — it is called inside the reconcile transaction',
  );
});
