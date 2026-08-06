const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The variation selector mints SYNTHETIC NEGATIVE ids (-propertyId) for typed
// Gauge/Numeric values — they ride along in customVariationValues and never
// become real nodes. Stock is keyed by real nodes only, so a challan line must
// resolve such an id to the deepest REAL node in the selected path.
//
// This has now broken twice, so it is pinned here. It must be repaired in
// normalizeDeliveryChallanItems specifically: the downstream snapshot call
// passes only (itemId, leafId) and DROPS the path node ids, so
// resolveOrderVariationSelection has nothing to fall back to and rejects the
// save with a misleading "Client, item, and variation values are required."
// Fixing it further downstream does not work.

test('a typed Gauge selection saves against the deepest real variation node', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-synthetic-leaf-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'leaf-owner@paper.local';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';

  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();

  try {
    const leaf = await backend.get(
      "SELECT item_id, id FROM item_variation_nodes WHERE kind = 'value' AND is_archived = 0 LIMIT 1",
    );
    const property = await backend.get(
      "SELECT id FROM item_variation_nodes WHERE kind = 'property' AND is_archived = 0 LIMIT 1",
    );
    assert.ok(leaf && property, 'expected a seeded variation tree');

    const vendor = await backend.saveVendor({
      name: 'Synthetic Leaf Vendor',
      gstNumber: '27ABCDE1234F1Z5',
      phone: '9999999999',
    });

    // Exactly what the mobile purchase wizard sends for a typed gauge value.
    const challan = await backend.saveDeliveryChallan(
      {
        type: 'reception',
        vendorId: vendor.id,
        maintainStocks: true,
        location: 'MAIN',
        items: [
          {
            itemId: leaf.item_id,
            variationLeafNodeId: -property.id, // synthetic, must not persist
            variationPathNodeIds: [leaf.id],
            particulars: 'Typed Gauge Line',
            quantityPcs: '5',
            weight: '0',
          },
        ],
      },
      { id: 1, name: 'probe', role: 'admin' },
    );

    const line = await backend.get(
      'SELECT variation_leaf_node_id FROM delivery_challan_items WHERE challan_id = ?',
      [challan.id],
    );
    assert.ok(line, 'expected the challan line to persist');
    assert.equal(
      line.variation_leaf_node_id,
      leaf.id,
      'synthetic negative id must resolve to the real node from the path',
    );
    assert.ok(line.variation_leaf_node_id > 0, 'no negative id may ever persist');
  } finally {
    await backend.closeDb?.();
  }
});

test('normalizeDeliveryChallanItems is the layer that repairs synthetic ids', () => {
  // Guard the LOCATION of the fix, not just its effect: putting it downstream
  // silently fails because the snapshot call drops the path node ids.
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('function normalizeDeliveryChallanItems');
  assert.ok(start > 0, 'expected normalizeDeliveryChallanItems to exist');
  const body = source.slice(start, start + 2500);
  assert.match(
    body,
    /resolveStockLeafNodeId\(item\)/,
    'normalizeDeliveryChallanItems must resolve the stock leaf, not pass the raw id through',
  );
});
