'use strict';

// ---------------------------------------------------------------------------
// Orders over HTTP: the lines themselves.
//
//   GET    /api/orders                          the list (paged, searchable)
//   GET    /api/orders/:id                      one line, numeric ids only
//   POST   /api/orders                          add a line, or merge into one
//   PUT    /api/orders/:id                      edit a line
//   PATCH  /api/orders/:id/lifecycle            move it along its lifecycle
//   DELETE /api/orders/:id                      remove a line and what hangs off it
//   GET    /api/orders/:id/activity             who did what
//   GET    /api/orders/:id/status-history       how its status moved
//   GET    /api/orders/:id/material-requirements
//   GET    /api/orders/:id/po-documents         its purchase-order documents
//   POST   /api/orders/:id/po-documents         link uploaded documents to it
//   POST   /api/order-po-uploads/intent         ask for somewhere to upload one
//   POST   /api/order-po-uploads/complete       say it arrived
//   POST   /api/order-po-documents/:id/read-url a link to read one
//
// `orders`, `order-po-uploads` and `order-po-documents` are first path segments,
// so the central CRUD gate maps these to the orders module. Handlers are the
// ones that lived in server.js, moved whole, oddities included (each is pinned
// in orders-routes.test.js):
//   - GET /:id answers numeric ids only and passes anything else on, which is
//     what lets /api/orders/fulfilment be reached;
//   - PUT answers with the raw database row, not the DTO;
//   - DELETE answers success for an id that is not there;
//   - DELETE reaches into production's tables (run_barcode_inputs,
//     pipeline_runs) to dissolve a line's runs. That SQL goes behind a
//     production port when production moves.
// ---------------------------------------------------------------------------

module.exports = function registerOrderRoutes(ctx) {
  const {
    app,
    get,
    all,
    run,
    requirePermission,
    cacheMasterData,
    getIo,
    orders,
    inventoryPorts,
  } = ctx;

  const emitOrdersChanged = () => {
    const io = getIo();
    if (io) io.emit('orders_changed');
  };

  app.get('/api/orders', requirePermission('config.read'), cacheMasterData, async (req, res) => {
    try {
      // Narrowing and paging are opt-in. A request with no `limit` gets every
      // order, exactly as before — several features legitimately need the whole
      // set (the production order picker, challan order-selection, a client's
      // history), and a default page size would silently truncate them.
      const search = String(req.query.search || '').trim();
      const clientId = Number(req.query.client_id || req.query.clientId || 0) || null;
      const limit = Number(req.query.limit || 0) || null;
      const offset = Number(req.query.offset || 0) || 0;
      const csv = (value) =>
        String(value || '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
      const statuses = csv(req.query.status);
      // Passed through unparsed: buildOrderFilter has to be able to tell "no ids
      // asked for" from "ids asked for that do not parse".
      const ids = csv(req.query.ids);

      const filter = { search, clientId, statuses, ids };
      const rows = await orders.getOrders({ ...filter, limit, offset });
      // Counted only when paging, so the unpaged path costs exactly what it did.
      const total = limit ? await orders.countOrders(filter) : rows.length;

      res.json({
        success: true,
        orders: rows.map(orders.rowToOrderDto),
        total,
        limit,
        offset,
        // Stated rather than inferred from a short page: "this is everything" and
        // "this is all that fits" must not look the same to a caller.
        hasMore: limit ? offset + rows.length < total : false,
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, orders: [], error: error.message });
    }
  });

  /// One order line, shaped exactly like a row of the list.
  ///
  /// The delta engine knows only (table, record_id) when a change arrives, so it
  /// needs to fetch that single record — and there was no route to do it with.
  /// `orders.getOrderRowById` has had the right projection all along, including the
  /// derived `status` and `total_delivered_qty`, and was never routed.
  ///
  /// A single path segment, so it cannot shadow the `/api/orders/:id/activity`
  /// family registered around it.
  app.get('/api/orders/:id', requirePermission('config.read'), cacheMasterData, async (req, res, next) => {
    // Numeric ids only, so this cannot swallow a sibling named path.
    // `/api/orders/fulfilment` is one segment too, and a bare `:id` captured it
    // and answered 404 — a wildcard registered before a literal wins, and the
    // literal is easy to miss among thirty routes. Guarding on shape makes the
    // route order-independent instead of order-dependent.
    if (!/^\d+$/.test(String(req.params.id || ''))) {
      next();
      return;
    }
    try {
      const row = await orders.getOrderRowById(req.params.id);
      if (!row) {
        res.status(404).json({ success: false, order: null, error: 'Order not found.' });
        return;
      }
      res.json({ success: true, order: orders.rowToOrderDto(row), error: null });
    } catch (error) {
      res.status(500).json({ success: false, order: null, error: error.message });
    }
  });

  app.post('/api/orders', requirePermission('config.write'), async (req, res) => {
    try {
      const actor = {
        id: req.user?.id || null,
        name: req.user?.name || 'System',
        role: req.user?.role || 'system',
        source: 'api'
      };
      const result = await orders.saveOrder({ ...(req.body || {}), actor }, { returnMeta: true });
      emitOrdersChanged();
      res.status(result.merged ? 200 : 201).json({
        success: true,
        order: orders.rowToOrderDto(result.orderRow),
        merged: result.merged,
        quantityBefore: result.quantityBefore,
        quantityAdded: result.quantityAdded,
        quantityAfter: result.quantityAfter,
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        order: null,
        error: error.message,
      });
    }
  });

  app.post('/api/order-po-uploads/intent', requirePermission('config.write'), async (req, res) => {
    try {
      const intent = await orders.createPoUploadIntent(req.body || {});
      res.status(intent.alreadyUploaded ? 200 : 201).json({
        success: true,
        intent,
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        intent: null,
        error: error.message,
      });
    }
  });

  app.post('/api/order-po-uploads/complete', requirePermission('config.write'), async (req, res) => {
    try {
      const document = await orders.completePoUpload(req.body || {});
      res.json({ success: true, document, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        document: null,
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:id/po-documents', requirePermission('config.read'), async (req, res) => {
    try {
      const documents = await orders.getPoDocumentsForOrder(Number(req.params.id));
      res.json({ success: true, documents, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        documents: [],
        error: error.message,
      });
    }
  });

  app.post('/api/orders/:id/po-documents', requirePermission('config.write'), async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const { newlyLinkedIds } = await orders.linkPoDocumentsToOrder(orderId, req.body?.documentIds || []);
      if (newlyLinkedIds.length > 0) {
        const actor = {
          id: req.user?.id || null,
          name: req.user?.name || 'System',
          role: req.user?.role || 'system',
          source: 'api'
        };
        await orders.insertOrderActivityLog({
          orderId,
          activityType: 'po_documents_linked',
          actor,
          details: { documentIds: newlyLinkedIds },
        });
      }
      const documents = await orders.getPoDocumentsForOrder(orderId);
      res.json({ success: true, documents, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        documents: [],
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:id/material-requirements', requirePermission('config.read'), async (req, res) => {
    try {
      const requirements = await all(
        'SELECT * FROM order_material_requirements WHERE order_id = ? ORDER BY id ASC',
        [Number(req.params.id)]
      );
      res.json({ success: true, requirements, error: null });
    } catch (error) {
      res.status(500).json({
        success: false,
        requirements: [],
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:id/activity', requirePermission('config.read'), async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const rows = await orders.getOrderActivity(orderId);
      res.json({ success: true, activities: rows.map(orders.rowToOrderActivityDto), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        activities: [],
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:id/status-history', requirePermission('config.read'), async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const rows = await orders.getOrderStatusHistory(orderId);
      res.json({ success: true, history: rows.map(orders.rowToOrderStatusHistoryDto), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        history: [],
        error: error.message,
      });
    }
  });

  app.post('/api/order-po-documents/:id/read-url', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await orders.createPoDocumentReadUrl(Number(req.params.id));
      res.json({ success: true, ...result, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        document: null,
        readUrl: null,
        error: error.message,
      });
    }
  });

  app.patch('/api/orders/:id/lifecycle', requirePermission('config.write'), async (req, res) => {
    try {
      const actor = {
        id: req.user?.id || null,
        name: req.user?.name || 'System',
        role: req.user?.role || 'system',
        source: 'api'
      };
      const order = await orders.updateOrderLifecycle({
        ...(req.body || {}),
        id: Number(req.params.id),
        actor
      });
      res.json({ success: true, order: orders.rowToOrderDto(order), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        order: null,
        error: error.message,
      });
    }
  });

  app.put('/api/orders/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const updates = req.body || {};
    
      // Begin transaction
      await run('BEGIN TRANSACTION');
    
      // Get existing order item
      const existingItem = await get('SELECT * FROM order_items WHERE id = ?', [orderId]);
      if (!existingItem) {
        await run('ROLLBACK').catch(() => {});
        return res.status(404).json({ success: false, error: 'Order not found.' });
      }

      const orderNo = updates.orderNo || existingItem.order_no;
      const clientId = updates.clientId || existingItem.client_id;
      let clientCode = updates.clientCode || existingItem.client_code;
      let clientName = updates.clientName || existingItem.client_name;
    
      // Auto-update client code and name if client changed
      if (updates.clientId && updates.clientId !== existingItem.client_id) {
        const client = await get('SELECT name, alias FROM clients WHERE id = ?', [updates.clientId]);
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
      const updated = orderRows.find(o => o.id === orderId);
      emitOrdersChanged();
      res.json({ success: true, order: updated, error: null });
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/orders/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      const actorName = req.user?.name || 'System';
    
      await run('BEGIN TRANSACTION');

      const wipBarcode = req.body?.wip_barcode;
      const wipQty = Number(req.body?.wip_qty || 0);
      const recoveredMovements = [];

      const assignments = await all('SELECT * FROM order_pipeline_assignments WHERE order_item_id = ?', [orderId]);
      for (const assignment of assignments) {
        const runId = assignment.pipeline_run_id;

        // Dissolve unused raw inputs (that were consumed) back to inventory
        const consumedMovements = await all(
          "SELECT * FROM inventory_movements WHERE movement_type = 'consume' AND reference_type = 'pipeline_run' AND reference_id = ?",
          [runId]
        );

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

        await run('DELETE FROM run_barcode_inputs WHERE run_id = ?', [runId]);
        await run('DELETE FROM pipeline_runs WHERE id = ?', [runId]);
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

      await run('DELETE FROM order_pipeline_assignments WHERE order_item_id = ?', [orderId]);
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

      // Audit log
      await run(
        "INSERT INTO activity_logs (entity_type, entity_id, action, actor_id, actor_name, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ['order', String(orderId), 'deleted', req.user?.id || 1, actorName, JSON.stringify({ reason: 'User requested Undo' }), new Date().toISOString()]
      ).catch(() => {});

      await run('COMMIT');
      emitOrdersChanged();
      res.json({ success: true, recoveredMovements, error: null });
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });
};
