'use strict';

// ---------------------------------------------------------------------------
// Orders module — HTTP routes.
//
// All 16 route registrations for orders territory moved VERBATIM from server.js.
// No logic edits; handler bodies are NOT re-indented. Registration order
// matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerOrdersModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
    listDeliveryChallans,
    getOrders,
    saveOrder,
    rowToOrderDto,
    createPoUploadIntent,
    completePoUpload,
    getPoDocumentsForOrder,
    linkPoDocumentsToOrder,
    insertOrderActivityLog,
    getOrderActivity,
    rowToOrderActivityDto,
    getOrderStatusHistory,
    rowToOrderStatusHistoryDto,
    getOrderPipelineRuns,
    getOrderProductionReport,
    createPoDocumentReadUrl,
    updateOrderLifecycle,
    getClientNameAndAlias,
    deleteOrderAndRecoverMovements,
    getIo,
  } = ctx;

app.get('/api/orders/:orderId/delivery-challans', requirePermission('config.read'), async (req, res) => {
  try {
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      res.status(400).json({
        success: false,
        data: [],
        message: 'Invalid order id.',
        error: 'Invalid order id.',
      });
      return;
    }
    const challans = await listDeliveryChallans({ orderId, type: 'delivery' });
    res.json({ success: true, data: challans, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      data: [],
      message: error.message,
      error: error.message,
    });
  }
});

app.get('/api/orders', requirePermission('config.read'), async (req, res) => {
  try {
    const rows = await getOrders();
    res.json({ success: true, orders: rows.map(rowToOrderDto), error: null });
  } catch (error) {
    res.status(500).json({ success: false, orders: [], error: error.message });
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
    const result = await saveOrder({ ...(req.body || {}), actor }, { returnMeta: true });
    const io = typeof getIo === 'function' ? getIo() : null;
    if (io) io.emit('orders_changed');
    res.status(result.merged ? 200 : 201).json({
      success: true,
      order: rowToOrderDto(result.orderRow),
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
    const intent = await createPoUploadIntent(req.body || {});
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
    const document = await completePoUpload(req.body || {});
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
    const documents = await getPoDocumentsForOrder(Number(req.params.id));
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
    const { newlyLinkedIds } = await linkPoDocumentsToOrder(orderId, req.body?.documentIds || []);
    if (newlyLinkedIds.length > 0) {
      const actor = {
        id: req.user?.id || null,
        name: req.user?.name || 'System',
        role: req.user?.role || 'system',
        source: 'api'
      };
      await insertOrderActivityLog({
        orderId,
        activityType: 'po_documents_linked',
        actor,
        details: { documentIds: newlyLinkedIds },
      });
    }
    const documents = await getPoDocumentsForOrder(orderId);
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
    const rows = await getOrderActivity(orderId);
    res.json({ success: true, activities: rows.map(rowToOrderActivityDto), error: null });
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
    const rows = await getOrderStatusHistory(orderId);
    res.json({ success: true, history: rows.map(rowToOrderStatusHistoryDto), error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      history: [],
      error: error.message,
    });
  }
});

app.get('/api/orders/:orderNo/pipeline-runs', requirePermission('config.read'), async (req, res) => {
  try {
    const orderNo = req.params.orderNo;
    const runs = await getOrderPipelineRuns(orderNo);
    res.json({ success: true, runs, error: null });
  } catch (error) {
    res.status(500).json({ success: false, runs: [], error: error.message });
  }
});

// Quantities-only production report for an order: pipeline stages with actual
// consumption/output/waste from stage_reconciliations. No costs by design —
// rates are filled in on paper.
app.get('/api/orders/:orderNo/production-report', requirePermission('config.read'), async (req, res) => {
  try {
    const orderNo = req.params.orderNo;
    const result = await getOrderProductionReport(orderNo);
    if (!result) {
      return res.status(404).json({ success: false, report: null, error: 'Order not found.' });
    }
    res.json({
      success: true,
      report: result,
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, report: null, error: error.message });
  }
});

app.post('/api/order-po-documents/:id/read-url', requirePermission('config.read'), async (req, res) => {
  try {
    const result = await createPoDocumentReadUrl(Number(req.params.id));
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
    const order = await updateOrderLifecycle({
      ...(req.body || {}),
      id: Number(req.params.id),
      actor
    });
    res.json({ success: true, order: rowToOrderDto(order), error: null });
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
      const client = await getClientNameAndAlias(updates.clientId);
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
    const orders = await getOrders();
    const updated = orders.find(o => o.id === orderId);
    const io = typeof getIo === 'function' ? getIo() : null;
    if (io) io.emit('orders_changed');
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
    const recoveredMovements = await deleteOrderAndRecoverMovements(orderId, req.body, actorName, req.user?.id || 1);
    const io = typeof getIo === 'function' ? getIo() : null;
    if (io) io.emit('orders_changed');
    res.json({ success: true, recoveredMovements, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

};
