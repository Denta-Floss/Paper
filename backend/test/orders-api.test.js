const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('orders persistence functions create, list, and transition lifecycle', async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'paper-orders-api-'));
  const dbPath = path.join(tempDir, 'paper.db');
  process.env.DB_PATH = dbPath;

  const backend = require('../server.js');

  try {
    await backend.initDb();

    const seededClients = await backend.getClientsWithUsage();
    const seededItems = await backend.getItemsWithUsage();
    const seededOrders = await backend.getOrders();
    const seededUnits = await backend.getUnitsWithUsage();
    assert.ok(seededUnits.length >= 4, 'expected seeded mock units');
    assert.ok(seededClients.length >= 3, 'expected seeded mock clients');
    assert.ok(seededItems.length >= 2, 'expected seeded mock items');
    assert.ok(seededOrders.length >= 4, 'expected seeded mock orders');

    const clientRow = (await backend.getClientsWithUsage()).find(
      (entry) => !entry.is_archived,
    );
    assert.ok(clientRow, 'expected an active seeded client');
    const client = backend.rowToClientDto(clientRow);

    const itemRows = await backend.getItemsWithUsage();
    const itemRow = itemRows.find((entry) => !entry.is_archived);
    assert.ok(itemRow, 'expected an active seeded item');
    const item = await backend.rowToItemDto(itemRow);

    const leaf = findFirstLeafVariation(item.variationTree || []);
    assert.ok(leaf, 'expected a seeded leaf variation path');

    const created = await backend.saveOrder({
      orderNo: 'ORD-DB-001',
      clientId: client.id,
      clientName: client.name,
      poNumber: 'PO-DB-77',
      clientCode: client.alias,
      itemId: item.id,
      itemName: item.displayName,
      variationLeafNodeId: leaf.id,
      variationPathLabel: leaf.displayName,
      variationPathNodeIds: leaf.path,
      quantity: 12,
      status: 'confirmed',
      startDate: '2026-04-04T00:00:00.000Z',
      endDate: '2026-04-10T00:00:00.000Z',
    });

    const createdDto = backend.rowToOrderDto
        ? backend.rowToOrderDto(created)
        : created;
    assert.equal(createdDto.orderNo, 'ORD-DB-001');
    assert.equal(createdDto.status, 'confirmed');
    assert.equal(createdDto.quantity, 12);

    const listedRows = await backend.getOrders();
    assert.equal(listedRows.length, seededOrders.length + 1);
    assert.ok(
      listedRows.some(
        (entry) =>
          entry.order_no === 'ORD-DB-001' && entry.variation_leaf_node_id === leaf.id,
      ),
    );

    const updated = await backend.updateOrderLifecycle({
      id: created.id,
      toStatus: 'allocated',
      reason: 'Stock reserved',
      startDate: '2026-04-05T00:00:00.000Z',
      endDate: '2026-04-12T00:00:00.000Z',
    });
    const updatedDto = backend.rowToOrderDto ? backend.rowToOrderDto(updated) : updated;
    assert.equal(updatedDto.status, 'allocated');
    assert.equal(updatedDto.endDate, '2026-04-12T00:00:00.000Z');

    const invalidTransitionPromise = backend.updateOrderLifecycle({
      id: created.id,
      toStatus: 'closed',
    });
    await assert.rejects(invalidTransitionPromise);

    const statusHistoryRows = await backend.getOrderStatusHistory(created.id);
    assert.ok(statusHistoryRows.length >= 2, 'expected status history rows');
    assert.equal(statusHistoryRows[0].to_status, 'allocated');
    assert.equal(statusHistoryRows[1].to_status, 'confirmed');

    const activityRows = await backend.getOrderActivity(created.id);
    assert.ok(activityRows.length >= 2, 'expected activity rows');
    assert.equal(activityRows[0].event_type, 'status_changed');
    assert.equal(activityRows[1].event_type, 'order_created');

    const materialRow = await backend.get(
      'SELECT * FROM materials WHERE kind = ? ORDER BY id ASC LIMIT 1',
      ['parent'],
    );
    assert.ok(materialRow, 'expected a seeded material for bom linkage');
    await backend.replaceItemBomLines({
      itemId: item.id,
      lines: [
        {
          materialBarcode: materialRow.barcode,
          quantityPerUnit: 2,
          wastagePercent: 0,
        },
      ],
    });
    const now = new Date().toISOString();
    await backend.run('DELETE FROM inventory_stock_positions WHERE material_barcode = ?', [
      materialRow.barcode,
    ]);
    await backend.run(
      `
      INSERT INTO inventory_stock_positions (
        material_barcode, location_id, lot_code, unit_id, on_hand_qty, reserved_qty, damaged_qty, updated_at
      ) VALUES (?, 'MAIN', '', ?, ?, 0, 0, ?)
      `,
      [materialRow.barcode, materialRow.unit_id || null, 100, now],
    );
    const refreshedRequirements = await backend.syncOrderMaterialRequirements({
      orderId: created.id,
      source: 'test',
    });
    await Promise.all([
      backend.syncOrderMaterialRequirements({ orderId: created.id, source: 'test' }),
      backend.syncOrderMaterialRequirements({ orderId: created.id, source: 'test' }),
    ]);
    assert.equal(refreshedRequirements.length, 1);
    assert.equal(Number(refreshedRequirements[0].required_qty), 24);
    assert.equal(Number(refreshedRequirements[0].allocated_qty), 0);

    const allocatedRequirements = await backend.allocateOrderMaterials({
      orderId: created.id,
      source: 'test',
    });
    assert.equal(allocatedRequirements.length, 1);
    assert.equal(Number(allocatedRequirements[0].allocated_qty), 24);
    assert.equal(Number(allocatedRequirements[0].shortage_qty), 0);

    const releasedRequirements = await backend.releaseOrderMaterials({
      orderId: created.id,
      source: 'test',
    });
    assert.equal(releasedRequirements.length, 1);
    assert.equal(Number(releasedRequirements[0].allocated_qty), 0);
    assert.equal(Number(releasedRequirements[0].shortage_qty), 24);
    const shortageSuggestions = await backend.getOrderProcurementSuggestions(created.id);
    assert.equal(shortageSuggestions.length, 1);
    assert.equal(String(shortageSuggestions[0].material_barcode), materialRow.barcode);
    assert.equal(Number(shortageSuggestions[0].shortage_qty), 24);
    assert.equal(
      String(shortageSuggestions[0].procurement_state || ''),
      String(materialRow.procurement_state || 'not_ordered'),
    );
    await backend.refreshOrderProcurementSuggestions({
      orderId: created.id,
      source: 'test',
    });
    const activityAfterRefresh = await backend.getOrderActivity(created.id);
    assert.equal(
      String(activityAfterRefresh[0].event_type || ''),
      'procurement_suggestions_refreshed',
    );

    await backend.allocateOrderMaterials({
      orderId: created.id,
      source: 'test',
    });
    const consumedRequirements = await backend.consumeOrderMaterials({
      orderId: created.id,
      source: 'test',
    });
    assert.equal(consumedRequirements.length, 1);
    assert.equal(Number(consumedRequirements[0].allocated_qty), 0);
    assert.equal(Number(consumedRequirements[0].consumed_qty), 24);
    assert.equal(Number(consumedRequirements[0].shortage_qty), 0);
    assert.equal(String(consumedRequirements[0].status), 'consumed');
    const suggestionsAfterConsume = await backend.getOrderProcurementSuggestions(
      created.id,
    );
    assert.equal(suggestionsAfterConsume.length, 0);
    const allSuggestions = await backend.getAllOrderProcurementSuggestions();
    assert.equal(allSuggestions.length, 0);

    const draft = await backend.saveOrder({
      orderNo: 'ORD-DB-TRANS-001',
      clientId: client.id,
      clientName: client.name,
      poNumber: 'PO-DB-TRANS-77',
      clientCode: client.alias,
      itemId: item.id,
      itemName: item.displayName,
      variationLeafNodeId: leaf.id,
      variationPathLabel: leaf.displayName,
      variationPathNodeIds: leaf.path,
      quantity: 3,
      status: 'draft',
    });
    const draftOptions = backend.getOrderTransitionOptions(draft);
    assert.deepEqual(
      draftOptions.map((entry) => entry.action),
      ['confirm', 'cancel'],
    );
    const confirmed = await backend.transitionOrderByAction({
      id: draft.id,
      action: 'confirm',
      source: 'test',
    });
    assert.equal(confirmed.status, 'confirmed');
    const confirmedOptions = backend
      .getOrderTransitionOptions(confirmed)
      .map((entry) => entry.action);
    assert.ok(confirmedOptions.includes('allocate'));
    assert.ok(confirmedOptions.includes('hold'));
  } finally {
    await backend.closeDb();
  }
});

function findFirstLeafVariation(nodes, currentPath = []) {
  for (const node of nodes) {
    const nextPath = [...currentPath, node.id];
    if (node.kind === 'value' && (!node.children || node.children.length === 0)) {
      return { id: node.id, displayName: node.displayName, path: nextPath };
    }
    const nested = findFirstLeafVariation(node.children || [], nextPath);
    if (nested) {
      return nested;
    }
  }
  return null;
}
