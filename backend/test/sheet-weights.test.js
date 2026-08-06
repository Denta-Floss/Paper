const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Per-sheet weights shipped as a mobile purchase-wizard feature (each sheet is
// weighed individually and the wizard gates Confirm on total-in == total-out),
// but the backend silently dropped them: normalizeDeliveryChallanItems emitted
// a fixed key set that omitted sheetWeights, so normalizeChallanSheetWeights
// always saw undefined and sheet_weights_json was written as '[]' on every
// save. The validation it performs was therefore never reached either.

test('per-sheet weights persist and must sum to the line weight', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-sheet-weights-'));
  process.env.DB_PATH = path.join(tempDir, 'paper.db');
  process.env.PAPER_SUPER_ADMIN_EMAIL = 'sheet-owner@paper.local';
  process.env.PAPER_SUPER_ADMIN_PASSWORD = 'OwnerPass1234';

  delete require.cache[require.resolve('../server.js')];
  const backend = require('../server.js');
  await backend.resetAndSeedDemoData();

  try {
    const leaf = await backend.get(
      "SELECT item_id, id FROM item_variation_nodes WHERE kind = 'value' AND is_archived = 0 LIMIT 1",
    );
    assert.ok(leaf, 'expected a seeded variation leaf');
    const vendor = await backend.saveVendor({
      name: 'Sheet Weight Vendor',
      gstNumber: '27ABCDE1234F1Z5',
      phone: '9999999999',
    });
    const actor = { id: 1, name: 'probe', role: 'admin' };

    const challan = await backend.saveDeliveryChallan(
      {
        type: 'reception',
        vendorId: vendor.id,
        maintainStocks: true,
        location: 'MAIN',
        items: [
          {
            itemId: leaf.item_id,
            variationLeafNodeId: leaf.id,
            particulars: 'Sheet Line',
            quantityPcs: '3',
            weight: '30',
            sheetWeights: [10, 10, 10],
          },
        ],
      },
      actor,
    );

    const line = await backend.get(
      'SELECT id, sheet_weights_json FROM delivery_challan_items WHERE challan_id = ?',
      [challan.id],
    );
    assert.deepEqual(
      JSON.parse(line.sheet_weights_json),
      [10, 10, 10],
      'per-sheet weights must persist, not be silently discarded',
    );

    // Piece barcodes are owned by POST /api/challans/:id/piece-barcodes, which
    // deletes-then-inserts with weight. Saving a challan must NOT also write
    // them — piece_barcodes.parent_code is UNIQUE, so a duplicate writer would
    // make re-saving a challan fail.
    const barcodes = await backend.all(
      'SELECT id FROM piece_barcodes WHERE challan_item_id = ?',
      [line.id],
    );
    assert.equal(barcodes.length, 0, 'saveDeliveryChallan must not write piece_barcodes');

    // The validation that was previously unreachable now actually runs.
    await assert.rejects(
      () =>
        backend.saveDeliveryChallan(
          {
            type: 'reception',
            vendorId: vendor.id,
            maintainStocks: true,
            location: 'MAIN',
            items: [
              {
                itemId: leaf.item_id,
                variationLeafNodeId: leaf.id,
                particulars: 'Mismatched',
                quantityPcs: '2',
                weight: '30',
                sheetWeights: [5, 5],
              },
            ],
          },
          actor,
        ),
      /Sheet weights must sum to the line weight/,
    );
  } finally {
    await backend.closeDb?.();
  }
});
