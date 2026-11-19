'use strict';

// ---------------------------------------------------------------------------
// Editing and deleting an order line.
//
// Both lived inside their HTTP handlers (PUT and DELETE /api/orders/:id), which
// meant the only way to edit or delete a line was to be a request. They are
// here whole, statements and oddities unchanged (each is pinned in
// orders-routes.test.js), and answer with a result instead of writing a
// response:
//   - an edit answers with the raw database row, not the DTO;
//   - a delete answers ok for an id that is not there.
//
// Built apart from service.js because a delete reaches into two neighbours:
// production, to find and dissolve the line's runs (asked at the kernel desk,
// inside this transaction), and inventory, to put the stock those runs
// consumed back (still its port, until inventory publishes operations).
// A delete still reads the movement ledger itself to find what was consumed.
//
// The delete used to end by inserting into `activity_logs`, a table that has
// never existed, with the error swallowed. That statement is gone.
// ---------------------------------------------------------------------------

function createOrderLineWrites({ get, all, run, orders, inventoryPorts, desk }) {
  async function editOrderLine(orderId, updates = {}) {
    try {
      await run('BEGIN TRANSACTION');

      const existingItem = await get('SELECT * FROM order_items WHERE id = ?', [orderId]);
      if (!existingItem) {
        await run('ROLLBACK').catch(() => {});
        return { ok: false, status: 404, error: 'Order not found.' };
      }

      const orderNo = updates.orderNo || existingItem.order_no;
      const clientId = updates.clientId || existingItem.client_id;
      let clientCode = updates.clientCode || existingItem.client_code;
      let clientName = updates.clientName || existingItem.client_name;

      // Auto-update client code and name if client changed
      if (updates.clientId && updates.clientId !== existingItem.client_id) {
        const { row: client } = await desk.ask('clients.rows.get', { id: updates.clientId });
        if (client) {
          clientName = client.name;
          clientCode = client.alias || client.name.substring(0, 3).toUpperCase();
        }
      }

      // Update order_headers if order_no or client changed
      if (orderNo !== existingItem.order_no || clientId !== existingItem.client_id) {
        // Create new header if it doesn't exist
        await run(
          'INSERT OR IGNORE INTO order_headers (order_no, client_id, po_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          [orderNo, clientId, '', new Date().toISOString(), new Date().toISOString()]
        );

        // Update header client_id if order_no stayed the same
        if (orderNo === existingItem.order_no) {
          await run('UPDATE order_headers SET client_id = ?, updated_at = ? WHERE order_no = ?', [clientId, new Date().toISOString(), orderNo]);
        }
      }

      await run(`
        UPDATE order_items
        SET order_no = ?, client_id = ?, client_name = ?, client_code = ?, item_id = ?,
            variation_leaf_node_id = ?, variation_path_label = ?, item_name = ?,
            hsn_code = ?, quantity = ?, unit_price = ?, taxable_value = ?,
            cgst_rate = ?, sgst_rate = ?, cgst_amount = ?, sgst_amount = ?, updated_at = ?
        WHERE id = ?
      `, [
        orderNo, clientId, clientName, clientCode,
        updates.itemId || existingItem.item_id,
        updates.variationLeafNodeId || existingItem.variation_leaf_node_id,
        updates.variationPathLabel || existingItem.variation_path_label,
        updates.itemName || existingItem.item_name,
        updates.hsnCode || existingItem.hsn_code,
        updates.quantity !== undefined ? updates.quantity : existingItem.quantity,
        updates.unitPrice !== undefined ? updates.unitPrice : existingItem.unit_price,
        updates.taxableValue !== undefined ? updates.taxableValue : existingItem.taxable_value,
        updates.cgstRate !== undefined ? updates.cgstRate : existingItem.cgst_rate,
        updates.sgstRate !== undefined ? updates.sgstRate : existingItem.sgst_rate,
        updates.cgstAmount !== undefined ? updates.cgstAmount : existingItem.cgst_amount,
        updates.sgstAmount !== undefined ? updates.sgstAmount : existingItem.sgst_amount,
        new Date().toISOString(),
        orderId
      ]);

      await run('COMMIT');
      const orderRows = await orders.getOrders();
      return { ok: true, order: orderRows.find((o) => o.id === orderId) };
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  /// Removes a line and what hangs off it. Its runs are dissolved and the raw
  /// stock they consumed is put back; a named work-in-progress lot can be put
  /// back with it. The header goes with its last line.
  async function deleteOrderLine({ orderId, actorName = 'System', wipBarcode = null, wipQty = 0 }) {
    try {
      await run('BEGIN TRANSACTION');

      const recoveredMovements = [];

      const { links: assignments } = await desk.ask('production.runs.linksForOrderItem', { orderItemId: orderId });
      for (const assignment of assignments) {
        const runId = assignment.pipeline_run_id;

        // Dissolve unused raw inputs (that were consumed) back to inventory
        const { rows: consumedMovements } = await desk.ask('inventory.movements.consumedByRun', {
          pipelineRunId: runId,
        });

        for (const move of consumedMovements) {
          const qty = move.qty;
          if (qty > 0) {
            await inventoryPorts.movements.applyCore({
              barcode: move.material_barcode,
              movementType: 'adjust_in',
              qty: qty,
              actor: actorName,
              referenceType: 'pipeline_dissolution',
              referenceId: String(orderId),
              reasonCode: 'ORDER_DELETED',
              toLocationId: move.from_location_id || 'MAIN'
            }, { useTransaction: false });
            recoveredMovements.push({ barcode: move.material_barcode, qty, reason: 'Raw Material Recovery' });
          }
        }

        await desk.ask('production.runs.dissolve', { runId });
      }

      if (wipBarcode && wipQty > 0) {
        await inventoryPorts.movements.applyCore({
          barcode: wipBarcode,
          movementType: 'adjust_in',
          qty: wipQty,
          actor: actorName,
          referenceType: 'pipeline_dissolution',
          referenceId: String(orderId),
          reasonCode: 'WIP_RECOVERY',
          toLocationId: 'MAIN'
        }, { useTransaction: false });
        recoveredMovements.push({ barcode: wipBarcode, qty: wipQty, reason: 'WIP Recovery' });
      }

      await desk.ask('production.runs.unlinkOrderItem', { orderItemId: orderId });
      await run('DELETE FROM order_status_history WHERE order_id = ?', [orderId]);
      await run('DELETE FROM order_activity_log WHERE order_id = ?', [orderId]);
      await run('DELETE FROM order_material_requirements WHERE order_id = ?', [orderId]);
      await run('DELETE FROM order_po_documents WHERE order_id = ?', [orderId]);

      const item = await get('SELECT order_no FROM order_items WHERE id = ?', [orderId]);
      if (item) {
        await run('DELETE FROM order_items WHERE id = ?', [orderId]);
        const otherItems = await get('SELECT id FROM order_items WHERE order_no = ?', [item.order_no]);
        if (!otherItems) {
          await run('DELETE FROM order_headers WHERE order_no = ?', [item.order_no]);
        }
      }

      await run('COMMIT');
      return { ok: true, recoveredMovements };
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  return { editOrderLine, deleteOrderLine };
}

module.exports = { createOrderLineWrites };
