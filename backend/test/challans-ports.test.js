const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Orders' delivered quantity and vendors' challan count used to be sub-SELECTs
// embedded in those modules' own list queries — i.e. orders and vendors read
// challans tables directly (K5). They now come from batched challans ports and
// are merged back onto the row, so callers see an identical shape.
//
// This test exists because "the suite still passes" is NOT evidence for a query
// refactor: nothing else asserts these two values against real data. It builds
// rows with known quantities and compares the port result to the original SQL.

test('challans ports return exactly what the old embedded sub-SELECTs returned', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-challans-ports-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'ports-owner@paper.local';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';

  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();

  try {
    const orderItems = await backend.all('SELECT id FROM order_items ORDER BY id LIMIT 3');
    assert.ok(orderItems.length >= 2, 'expected seeded order items');

    const vendorA = await backend.saveVendor({
      name: 'Ports Vendor A',
      gstNumber: '27ABCDE1234F1Z5',
      phone: '9999999991',
    });
    const vendorB = await backend.saveVendor({
      name: 'Ports Vendor B',
      gstNumber: '29AAACN4455J1Z7',
      phone: '9999999992',
    });

    const now = new Date().toISOString();
    const mkChallan = async (no, vendorId, status) => {
      const res = await backend.run(
        `INSERT INTO delivery_challans (challan_no, type, status, vendor_id, date, created_at, updated_at)
         VALUES (?, 'reception', ?, ?, ?, ?, ?)`,
        [no, status, vendorId, now, now, now],
      );
      return res.lastID;
    };
    const mkLine = async (challanId, orderItemId, qty) => {
      await backend.run(
        `INSERT INTO delivery_challan_items (challan_id, order_item_id, line_no, particulars, quantity_pcs, weight, created_at, updated_at)
         VALUES (?, ?, 1, 'ports probe', ?, '0', ?, ?)`,
        [challanId, orderItemId, String(qty), now, now],
      );
    };

    // Vendor A: two challans, one of them cancelled (must still count for the
    // vendor tally, but its lines must NOT count as delivered).
    const c1 = await mkChallan('PORTS-1', vendorA.id, 'issued');
    const c2 = await mkChallan('PORTS-2', vendorA.id, 'cancelled');
    const c3 = await mkChallan('PORTS-3', vendorB.id, 'issued');

    await mkLine(c1, orderItems[0].id, 7);
    await mkLine(c1, orderItems[1].id, 3);
    await mkLine(c2, orderItems[0].id, 100); // cancelled — excluded from delivered
    await mkLine(c3, orderItems[0].id, 5);

    // --- delivered quantity ---------------------------------------------
    const oldDelivered = await backend.all(`
      SELECT o.id,
        (SELECT SUM(dci.quantity_pcs)
         FROM delivery_challan_items dci
         JOIN delivery_challans dc ON dci.challan_id = dc.id
         WHERE dci.order_item_id = o.id AND dc.status != 'cancelled') AS q
      FROM order_items o`);
    const viaPorts = await backend.getOrders();
    const portMap = new Map(
      viaPorts.map((row) => [Number(row.id), Number(row.total_delivered_qty || 0)]),
    );

    let compared = 0;
    for (const row of oldDelivered) {
      assert.equal(
        portMap.get(Number(row.id)),
        Number(row.q || 0),
        `delivered qty mismatch for order item ${row.id}`,
      );
      compared += 1;
    }
    assert.ok(compared > 0, 'expected order items to compare');

    // The fixture must actually exercise the values, or the comparison above is
    // vacuous — this is the check that makes the test meaningful.
    assert.equal(portMap.get(Number(orderItems[0].id)), 12, '7 + 5, cancelled 100 excluded');
    assert.equal(portMap.get(Number(orderItems[1].id)), 3);

    // --- vendor challan counts -------------------------------------------
    const oldCounts = await backend.all(
      `SELECT v.id, (SELECT COUNT(*) FROM delivery_challans WHERE vendor_id = v.id) AS c FROM vendors v`,
    );
    const vendorRows = await backend.getVendorsWithUsage();
    const vendorMap = new Map(vendorRows.map((r) => [Number(r.id), Number(r.usage_count || 0)]));
    for (const row of oldCounts) {
      assert.equal(
        vendorMap.get(Number(row.id)),
        Number(row.c || 0),
        `vendor usage mismatch for vendor ${row.id}`,
      );
    }
    assert.equal(vendorMap.get(Number(vendorA.id)), 2, 'cancelled challans still count as usage');
    assert.equal(vendorMap.get(Number(vendorB.id)), 1);

    // --- single-row paths must agree with the batch paths -----------------
    const singleVendor = await backend.getVendorRowById(vendorA.id);
    assert.equal(Number(singleVendor.usage_count), 2);
    const emptyVendorMap = await backend.getVendorsWithUsage();
    assert.ok(emptyVendorMap.every((r) => typeof r.usage_count === 'number'));
  } finally {
    await backend.closeDb?.();
  }
});

test('challans ports meter their traffic and reject a missing implementation', () => {
  const { createChallansPorts, normalizeIds } = require('../modules/challans/ports');
  assert.deepEqual(normalizeIds([3, '3', 0, -1, null, 4]), [3, 4], 'ids are deduped and positive');

  const ports = createChallansPorts({
    qtyByOrderItems: async () => new Map(),
    countByVendors: async () => new Map(),
    receptionLinesForVendor: async () => [],
  });
  assert.ok('delivery.qtyByOrderItems' in ports.stats());
  assert.ok('usage.countByVendors' in ports.stats());
  assert.ok('reception.linesForVendor' in ports.stats());
  assert.throws(() => createChallansPorts({ qtyByOrderItems: async () => {} }), /has no implementation/);
});
