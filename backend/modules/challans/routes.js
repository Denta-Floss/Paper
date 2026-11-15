'use strict';

// ---------------------------------------------------------------------------
// Challans over HTTP.
//
// Every route below except the four marked * is registered twice, under
// /api/challans and /api/delivery-challans, from one handler.
//
//   GET    …                          the list
//   POST   …                          create a draft
//   GET    …/:id                      one
//   PUT    …/:id                      edit
//   DELETE …/:id                      remove a draft
//   POST   …/:id/issue                issue it: freezes the snapshot, moves stock
//   POST   …/:id/cancel               cancel it and put stock back
//   GET    …/:id/cancel-options       what stands in the way (linked invoices)
//   PATCH  …/:id/report-groups        which report groups it counts in
//   POST   …/:id/print                record that it was printed
//   POST   …/:id/reconcile            settle an internal-use challan into scrap,
//                                     leftover, lost, rejection and finished goods
//   POST   /api/challans/:id/piece-barcodes *            per-piece barcodes
//   POST   /api/delivery-challans/:id/assets/upload-intent *
//   POST   /api/delivery-challans/:id/assets/upload-complete *
//   GET    /api/orders/:orderId/delivery-challans *      an order's challans
//
// `challans` and `delivery-challans` map to the challans module in the central
// gate (reconcile to challans.reconcile); the order-path route is gated as
// orders. Handlers are the ones that lived in server.js, moved whole. Notifying
// other screens (challan_generated_ok, item_updated) goes through getIo(),
// because the socket server is created after this module is registered.
//
// NOT here: GET /api/delivery-challans/health stays in server.js, ahead of the
// login gate.
//
// KNOWN BUGS, kept until their own fixes and recorded in
// challans-routes.test.js:
//   - reconcile opens a transaction and then saves a new scrap item, which
//     opens its own; SQLite refuses the second and the settle fails;
//   - assets/upload-complete calls handleAssetUploadComplete, which does not
//     exist.
// ---------------------------------------------------------------------------

module.exports = function registerChallanRoutes(ctx) {
  const {
    challanService,
    app,
    get,
    all,
    run,
    requirePermission,
    cacheMasterData,
    getIo,
    nowIso,
    rowToUploadedAssetDto,
    normalizeChallanType,
    createAssetUploadIntent,
    inventoryPorts,
    actorFromRequest,
    ensureReconcilePrimaryGroup,
    ensureReconcileSubGroup,
    ensureReconcileItem,
    ensureKgUnit,
  } = ctx;

  const handleListChallans = async (req, res) => {
    try {
      const challans = await challanService.listDeliveryChallans({
        type: String(req.query.type || '').trim(),
        status: String(req.query.status || '').trim(),
        search: String(req.query.search || '').trim(),
        dateFrom: String(req.query.date_from || req.query.dateFrom || '').trim(),
        dateTo: String(req.query.date_to || req.query.dateTo || '').trim(),
        orderId: req.query.order_id || req.query.orderId,
        vendorId: req.query.vendor_id || req.query.vendorId,
        itemId: req.query.item_id || req.query.itemId,
        variationLeafNodeId:
          req.query.variation_leaf_node_id || req.query.variationLeafNodeId,
        // Challan Book: ?mine=1 scopes to the caller; or an explicit created_by.
        createdBy: (req.query.mine === '1' || req.query.mine === 'true')
          ? req.user?.id
          : (req.query.created_by || req.query.createdBy),
      });
      res.json({ success: true, data: challans, error: null });
    } catch (error) {
      res.status(500).json({ success: false, data: [], message: error.message, error: error.message });
    }
  };

  app.get('/api/challans', requirePermission('config.read'), cacheMasterData, handleListChallans);

  app.get('/api/delivery-challans', requirePermission('config.read'), cacheMasterData, handleListChallans);

  const handleCreateChallan = async (req, res) => {
    try {
      const challan = await challanService.saveDeliveryChallan(req.body || {}, actorFromRequest(req), req);
      const warning = await challanService.challanNumberWarning(
        req.body?.challanNo ?? req.body?.challan_no,
        challan.type,
      );
      const challanDto = await challanService.rowToDeliveryChallanDto(challan);
      if (getIo()) {
        getIo().emit('challan_generated_ok', challanDto);
      }
      res.status(201).json({
        success: true,
        data: challanDto,
        warnings: warning ? [warning] : [],
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  };

  app.post('/api/challans', requirePermission('config.write'), handleCreateChallan);

  app.post('/api/delivery-challans', requirePermission('config.write'), handleCreateChallan);

  // Persist the piece/sheet barcodes generated on the mobile wizard's Done step,
  // after the challan (and its number) already exist. Kept separate from the
  // challan upsert because that path deletes-and-reinserts every item (cascade-
  // wiping barcodes and re-running issuance). Idempotent: replaces the barcodes
  // for each referenced item, so re-generating or re-printing is safe.
  app.post('/api/challans/:id/piece-barcodes', requirePermission('config.write'), async (req, res) => {
    try {
      const challanId = Number(req.params.id);
      if (!Number.isInteger(challanId) || challanId <= 0) {
        return res.status(400).json({ success: false, data: null, error: 'Invalid challan id.' });
      }
      const challan = await get('SELECT id FROM delivery_challans WHERE id = ?', [challanId]);
      if (!challan) {
        return res.status(404).json({ success: false, data: null, error: 'Challan not found.' });
      }

      const incoming = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
      const itemRows = await all('SELECT id FROM delivery_challan_items WHERE challan_id = ?', [challanId]);
      const validItemIds = new Set(itemRows.map((row) => row.id));

      const clean = [];
      const touchedItemIds = new Set();
      for (const pb of incoming) {
        const itemId = Number(pb.challanItemId ?? pb.challan_item_id);
        if (!validItemIds.has(itemId)) {
          return res.status(400).json({
            success: false,
            data: null,
            error: `Barcode references an item that is not part of challan ${challanId}.`,
          });
        }
        const parentCode = String(pb.parentCode ?? pb.parent_code ?? '').trim();
        const childCode = String(pb.childCode ?? pb.child_code ?? '').trim();
        if (!parentCode || !childCode) continue;
        const weightNum = Number(pb.weight ?? 0);
        clean.push({
          itemId,
          parentCode,
          childCode,
          weight: Number.isFinite(weightNum) && weightNum >= 0 ? weightNum : 0,
        });
        touchedItemIds.add(itemId);
      }

      const now = nowIso();
      await run('BEGIN TRANSACTION');
      try {
        for (const itemId of touchedItemIds) {
          await run('DELETE FROM piece_barcodes WHERE challan_item_id = ?', [itemId]);
        }
        for (const pb of clean) {
          await run(
            'INSERT INTO piece_barcodes (challan_item_id, parent_code, child_code, weight, created_at) VALUES (?, ?, ?, ?, ?)',
            [pb.itemId, pb.parentCode, pb.childCode, pb.weight, now],
          );
        }
        await run('COMMIT');
      } catch (err) {
        await run('ROLLBACK');
        throw err;
      }

      const saved = await challanService.getDeliveryChallanRowById(challanId);
      const dto = await challanService.rowToDeliveryChallanDto(saved);
      res.json({ success: true, data: dto, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  });

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
      const challans = await challanService.listDeliveryChallans({ orderId, type: 'delivery' });
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

  const handleGetChallan = async (req, res) => {
    try {
      const challan = await challanService.getDeliveryChallanRowById(Number(req.params.id));
      if (!challan) {
        res.status(404).json({
          success: false,
          data: null,
          message: 'Challan not found.',
          error: 'Challan not found.',
        });
        return;
      }
      res.json({ success: true, data: await challanService.rowToDeliveryChallanDto(challan), error: null });
    } catch (error) {
      res.status(500).json({ success: false, data: null, message: error.message, error: error.message });
    }
  };

  app.get('/api/challans/:id', requirePermission('config.read'), handleGetChallan);

  app.get('/api/delivery-challans/:id', requirePermission('config.read'), handleGetChallan);

  const handleUpdateChallan = async (req, res) => {
    try {
      const challan = await challanService.saveDeliveryChallan(
        { ...(req.body || {}), id: Number(req.params.id) },
        actorFromRequest(req),
        req,
      );
      const warning = await challanService.challanNumberWarning(
        req.body?.challanNo ?? req.body?.challan_no,
        challan.type,
      );
      res.json({
        success: true,
        data: await challanService.rowToDeliveryChallanDto(challan),
        warnings: warning ? [warning] : [],
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  };

  app.put('/api/challans/:id', requirePermission('config.write'), handleUpdateChallan);

  app.put('/api/delivery-challans/:id', requirePermission('config.write'), handleUpdateChallan);

  const handleIssueChallan = async (req, res) => {
    try {
      const challan = await challanService.issueDeliveryChallan(Number(req.params.id), actorFromRequest(req));
      res.json({ success: true, data: await challanService.rowToDeliveryChallanDto(challan), error: null });
    
      // Emit item_updated for each item affected if stock was modified
      if (getIo() && challan && Number(challan.maintain_stocks || 1) !== 0) {
        const items = await all('SELECT item_id FROM delivery_challan_items WHERE challan_id = ?', [challan.id]);
        const uniqueItemIds = new Set(items.map(i => i.item_id).filter(id => Number.isFinite(id) && id > 0));
        for (const itemId of uniqueItemIds) {
          getIo().emit('item_updated', { id: itemId });
        }
      }
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  };

  app.post('/api/challans/:id/issue', requirePermission('config.write'), handleIssueChallan);

  app.post('/api/delivery-challans/:id/issue', requirePermission('config.write'), handleIssueChallan);

  // ── INTERNAL-USE CHALLAN RECONCILIATION ──
  // Settle a consumed internal-use challan: every line's taken quantity is split
  // across five buckets (scrap / leftover / lost / rejection / finished goods),
  // each bucket reverted back into inventory as a named item + lot under the
  // Primary Group's matching sub-group, then the challan is marked completed and
  // (once all of an order's use challans are reconciled) the order is completed.
  //
  // This mirrors the pipeline-run scrap/leftover mechanic (see /api/production-scrap
  // and PUT /runs/:id/node-metrics): create a `materials` lot linked to a reused
  // group + item, then apply a `receive` inventory movement. Groups/items are
  // reused when they already exist; items are named "<bucket>_<itemName>_<date>".
  const RECONCILE_BUCKETS = [
    { key: 'scrap', prefix: 'scrap', group: 'Scrap' },
    { key: 'leftover', prefix: 'leftover', group: 'Leftover' },
    { key: 'lost', prefix: 'lost', group: 'Lost' },
    { key: 'rejection', prefix: 'rejection', group: 'Rejection' },
    { key: 'finishedGoods', prefix: 'finished_goods', group: 'Finished Goods' },
  ];

  const handleReconcileChallan = async (req, res) => {
    const challanId = Number(req.params.id);
    try {
      if (!Number.isInteger(challanId) || challanId <= 0) {
        const error = new Error('Invalid challan id.');
        error.statusCode = 400;
        throw error;
      }
      const challan = await challanService.getDeliveryChallanRowById(challanId);
      if (!challan) {
        const error = new Error('Challan not found.');
        error.statusCode = 404;
        throw error;
      }
      if (normalizeChallanType(challan.type) !== 'internal') {
        const error = new Error('Only internal-use challans can be settled.');
        error.statusCode = 400;
        throw error;
      }
      if (challan.status === 'completed' || String(challan.reconciliation_json || '').trim()) {
        const error = new Error('This challan has already been settled.');
        error.statusCode = 409;
        throw error;
      }

      const items = await challanService.getDeliveryChallanItems(challanId);
      if (items.length === 0) {
        const error = new Error('This challan has no lines to settle.');
        error.statusCode = 400;
        throw error;
      }

      // Index the client's per-line splits by the challan line id they settle.
      const requestLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
      const splitByLineId = new Map();
      for (const line of requestLines) {
        const lineId = Number(line?.challanItemId || line?.id || 0);
        if (Number.isInteger(lineId) && lineId > 0) splitByLineId.set(lineId, line);
      }

      // Validate every line balances exactly before mutating anything.
      const plan = [];
      for (const item of items) {
        const split = splitByLineId.get(Number(item.id));
        if (!split) {
          const error = new Error(`Missing amounts for line "${item.particulars || item.id}".`);
          error.statusCode = 400;
          throw error;
        }
        const buckets = split.buckets || {};
        const amounts = {};
        let sum = 0;
        for (const bucket of RECONCILE_BUCKETS) {
          const value = Number(buckets[bucket.key] || 0);
          if (!Number.isFinite(value) || value < 0) {
            const error = new Error(`Invalid ${bucket.key} amount for line "${item.particulars || item.id}".`);
            error.statusCode = 400;
            throw error;
          }
          amounts[bucket.key] = value;
          sum += value;
        }
        // Reconciliation settles the WEIGHT taken (kg), not the piece count.
        const taken = Number(item.weight || 0);
        if (Math.abs(sum - taken) > 0.01) {
          const error = new Error(
            `Line "${item.particulars || item.id}" must settle its full ${taken} kg; got ${Number(sum.toFixed(4))} kg.`,
          );
          error.statusCode = 400;
          throw error;
        }
        plan.push({ item, amounts, taken });
      }

      const actor = actorFromRequest(req);
      const primaryGroup = await ensureReconcilePrimaryGroup();
      const kgUnitId = await ensureKgUnit();
      const dateStr = new Date().toISOString().slice(0, 10);
      const breakdown = [];
      const affectedItemIds = new Set();
      const subGroupCache = new Map();

      await run('BEGIN TRANSACTION');
      try {
        for (const entry of plan) {
          const { item, amounts, taken } = entry;
          const sourceItem = item.item_id
            ? await get(
                `SELECT i.id, i.name, i.display_name, i.unit_id, u.symbol AS unit_symbol
                 FROM items i LEFT JOIN units u ON u.id = i.unit_id WHERE i.id = ?`,
                [Number(item.item_id)],
              )
            : null;
          const baseName = String(
            sourceItem?.name || item.particulars || `item-${item.item_id || item.id}`,
          ).trim();
          // Reverted quantities are weights, so recon items/lots are in kg
          // regardless of the source item's own unit (which may be pieces).
          const unitId = kgUnitId;
          const unitSymbol = 'kg';

          const lineResult = {
            challanItemId: item.id,
            sourceItemId: item.item_id || null,
            itemName: baseName,
            variationLeafNodeId: Number(item.variation_leaf_node_id || 0),
            unit: unitSymbol,
            taken,
            buckets: amounts,
            reverts: [],
          };

          for (const bucket of RECONCILE_BUCKETS) {
            const qty = amounts[bucket.key];
            if (!(qty > 0)) continue;

            let subGroupId = subGroupCache.get(bucket.group);
            if (!subGroupId) {
              subGroupId = await ensureReconcileSubGroup(bucket.group, primaryGroup.id, unitId);
              subGroupCache.set(bucket.group, subGroupId);
            }

            const reconItemName = `${bucket.prefix}_${baseName}_${dateStr}`;
            const reconItemId = await ensureReconcileItem(reconItemName, subGroupId, unitId);
            affectedItemIds.add(reconItemId);

            const lotBarcode = `LOT-RECON-${challanId}-${bucket.prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            await run(
              `INSERT INTO materials (
                barcode, name, type, kind, group_mode,
                linked_group_id, linked_item_id, linked_variation_leaf_node_id,
                unit, unit_id, inventory_state, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                lotBarcode, reconItemName, 'Reconciled', 'lot', 'tracked',
                subGroupId, reconItemId, 0,
                unitSymbol, unitId, 'available', nowIso(),
              ],
            );

            await inventoryPorts.movements.applyCore(
              {
                barcode: lotBarcode,
                movementType: 'receive',
                qty,
                primaryQty: qty,
                uom: unitSymbol,
                toLocationId: 'MAIN',
                reasonCode: 'challan_reconcile',
                referenceType: 'challan_reconcile',
                referenceId: String(challanId),
                lotCode: lotBarcode,
                actor: actor?.id || null,
              },
              { useTransaction: false },
            );

            lineResult.reverts.push({
              bucket: bucket.key,
              subGroupId,
              itemId: reconItemId,
              itemName: reconItemName,
              lotBarcode,
              qty,
            });
          }

          breakdown.push(lineResult);
        }

        const now = nowIso();
        await run(
          `UPDATE delivery_challans SET status = 'completed', reconciliation_json = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
          [JSON.stringify(breakdown), actor?.id || null, now, challanId],
        );

        await run('COMMIT');
      } catch (error) {
        await run('ROLLBACK');
        throw error;
      }

      // Order completion runs after COMMIT because updateOrderLifecycle manages
      // its own transaction (SQLite has no nested transactions). Once no other use
      // challan for this order is still awaiting reconciliation, every order line
      // for that order number is marked completed (best-effort).
      const completedOrderIds = [];
      const orderNo = await challanService.resolveReconcileOrderNo(challan);
      if (orderNo) {
        const pending = await challanService.pendingUseChallanCountForOrderNo(
          challan.internal_purpose || '',
          challanId,
        );
        if (pending === 0) {
          const orderItems = await all(
            `SELECT id FROM order_items WHERE order_no = ?`,
            [orderNo],
          );
          for (const orderItem of orderItems) {
            const done = await challanService.completeOrderItemBestEffort(orderItem.id, actor);
            if (done) completedOrderIds.push(orderItem.id);
          }
        }
      }

      const updatedRow = await challanService.getDeliveryChallanRowById(challanId);
      const dto = await challanService.rowToDeliveryChallanDto(updatedRow);
      if (getIo()) {
        getIo().emit('challan_generated_ok', dto);
        for (const itemId of affectedItemIds) getIo().emit('item_updated', { id: itemId });
      }

      res.json({
        success: true,
        data: dto,
        reconciliation: { breakdown, completedOrderIds },
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  };

  app.post('/api/challans/:id/reconcile', requirePermission('config.write'), handleReconcileChallan);

  app.post('/api/delivery-challans/:id/reconcile', requirePermission('config.write'), handleReconcileChallan);

  const handleGetCancelOptions = async (req, res) => {
    try {
      const id = Number(req.params.id);
      const invoices = await all(
        `SELECT DISTINCT ih.id, ih.status 
         FROM invoice_headers ih 
         JOIN invoice_lines il ON ih.id = il.invoice_id 
         WHERE il.challan_id = ?`, [id]
      );
      const actions = [];
      actions.push({
        key: 'block',
        label: 'Cancel linked invoices manually',
        description: 'You must handle each linked invoice first, then cancel the challan.',
        requiresConfirmation: false
      });
      const drafts = invoices.filter(i => i.status === 'draft');
      const issued = invoices.filter(i => i.status !== 'draft');
      if (drafts.length > 0 && issued.length === 0) {
        actions.push({
          key: 'cascade_delete_drafts_only',
          label: `Delete ${drafts.length} draft invoice(s) and cancel challan`,
          description: 'Draft invoices will be permanently deleted. No issued invoices are affected.',
          requiresConfirmation: true
        });
      }
      res.json({ success: true, challanId: id, linkedInvoices: invoices, availableActions: actions, error: null });
    } catch (error) {
      res.status(500).json({ success: false, data: null, message: error.message, error: error.message });
    }
  };

  const handleCancelChallan = async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { action } = req.body;
    
      const invoices = await all(
        `SELECT DISTINCT ih.id, ih.status 
         FROM invoice_headers ih 
         JOIN invoice_lines il ON ih.id = il.invoice_id 
         WHERE il.challan_id = ?`, [id]
      );

      if (invoices.length > 0) {
        if (!action || action === 'block') {
          const err = new Error('Please handle linked invoices manually before cancelling.');
          err.statusCode = 400;
          throw err;
        }
        if (action === 'cascade_delete_drafts_only') {
          const issued = invoices.filter(i => i.status !== 'draft');
          if (issued.length > 0) {
            const err = new Error('Issued invoices present; cannot auto-delete.');
            err.statusCode = 400;
            throw err;
          }
          for (const draft of invoices) {
            await run('DELETE FROM invoice_lines WHERE invoice_id = ?', [draft.id]);
            await run('DELETE FROM invoice_headers WHERE id = ?', [draft.id]);
          }
        } else {
          const err = new Error('Invalid cancel action.');
          err.statusCode = 400;
          throw err;
        }
      }

      const challan = await challanService.cancelDeliveryChallan(id, actorFromRequest(req));
      res.json({ success: true, data: await challanService.rowToDeliveryChallanDto(challan), error: null });
    
      // Emit item_updated for each item affected if stock was modified
      if (getIo() && challan && Number(challan.maintain_stocks || 1) !== 0) {
        const items = await all('SELECT item_id FROM delivery_challan_items WHERE challan_id = ?', [challan.id]);
        const uniqueItemIds = new Set(items.map(i => i.item_id).filter(id => Number.isFinite(id) && id > 0));
        for (const itemId of uniqueItemIds) {
          getIo().emit('item_updated', { id: itemId });
        }
      }
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  };

  app.post('/api/challans/:id/cancel', requirePermission('config.write'), handleCancelChallan);

  app.post('/api/delivery-challans/:id/cancel', requirePermission('config.write'), handleCancelChallan);

  app.get('/api/challans/:id/cancel-options', requirePermission('config.write'), handleGetCancelOptions);

  app.get('/api/delivery-challans/:id/cancel-options', requirePermission('config.write'), handleGetCancelOptions);

  const handleUpdateChallanReportGroups = async (req, res) => {
    try {
      const challanId = Number(req.params.id);
      const existing = await challanService.getDeliveryChallanRowById(challanId);
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          message: 'Challan not found.',
          error: 'Challan not found.',
        });
        return;
      }
      const requestedCodes = normalizeChallanType(existing.type) === 'delivery'
        ? await challanService.effectiveReportGroupCodesForChallan(existing)
        : challanService.normalizeReportGroupCodes(
            req.body?.reportGroupCodes ?? req.body?.report_group_codes ?? [],
          );
      await run('BEGIN TRANSACTION');
      try {
        await challanService.replaceChallanReportGroups(challanId, requestedCodes);
        await challanService.logDeliveryChallanActivity(
          challanId,
          'report_groups_updated',
          actorFromRequest(req),
          { reportGroupCodes: requestedCodes },
        );
        await run('COMMIT');
      } catch (error) {
        await run('ROLLBACK');
        throw error;
      }
      const refreshed = await challanService.getDeliveryChallanRowById(challanId);
      res.json({
        success: true,
        data: await challanService.rowToDeliveryChallanDto(refreshed),
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  };

  app.patch('/api/challans/:id/report-groups', requirePermission('config.write'), handleUpdateChallanReportGroups);

  app.patch('/api/delivery-challans/:id/report-groups', requirePermission('config.write'), handleUpdateChallanReportGroups);

  const handlePrintChallan = async (req, res) => {
    try {
      const challan = await challanService.getDeliveryChallanRowById(Number(req.params.id));
      if (!challan) {
        res.status(404).json({
          success: false,
          data: null,
          message: 'Challan not found.',
          error: 'Challan not found.',
        });
        return;
      }
      await challanService.logDeliveryChallanActivity(Number(req.params.id), 'challan_printed', actorFromRequest(req), {
        challanNo: challan.challan_no,
      });
      res.json({ success: true, data: null, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  };

  app.post('/api/challans/:id/print', requirePermission('config.write'), handlePrintChallan);

  app.post('/api/delivery-challans/:id/print', requirePermission('config.write'), handlePrintChallan);

  const handleDeleteChallan = async (req, res) => {
    try {
      await challanService.deleteDraftDeliveryChallan(Number(req.params.id), actorFromRequest(req));
      res.json({ success: true, data: null, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  };

  app.delete('/api/challans/:id', requirePermission('config.write'), handleDeleteChallan);

  app.delete('/api/delivery-challans/:id', requirePermission('config.write'), handleDeleteChallan);

  app.post('/api/delivery-challans/:id/assets/upload-intent', requirePermission('config.write'), async (req, res) => {
    try {
      const entityId = Number(req.params.id);
      if (!Number.isInteger(entityId) || entityId <= 0) {
        res.status(400).json({
          success: false,
          intent: null,
          error: 'A valid challan id is required.',
        });
        return;
      }
      const requestedEntityId = req.body?.entityId;
      if (requestedEntityId != null && Number(requestedEntityId) !== entityId) {
        res.status(400).json({
          success: false,
          intent: null,
          error: 'Request challan id does not match the upload route challan id.',
        });
        return;
      }
      const intent = await createAssetUploadIntent({
        ...(req.body || {}),
        entityType: 'delivery_challan',
        entityId,
      });
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

  app.post('/api/delivery-challans/:id/assets/upload-complete', requirePermission('config.write'), async (req, res) => {
    try {
      const entityId = Number(req.params.id);
      if (!Number.isInteger(entityId) || entityId <= 0) {
        res.status(400).json({
          success: false,
          asset: null,
          error: 'A valid challan id is required.',
        });
        return;
      }
      const requestedEntityId = req.body?.entityId;
      if (requestedEntityId != null && Number(requestedEntityId) !== entityId) {
        res.status(400).json({
          success: false,
          asset: null,
          error: 'Request challan id does not match the upload route challan id.',
        });
        return;
      }
      const assetRow = await handleAssetUploadComplete({
        ...(req.body || {}),
        entityType: 'delivery_challan',
        entityId,
      });
      const assetDto = await rowToUploadedAssetDto(assetRow);
      res.status(200).json({
        success: true,
        asset: assetDto,
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        asset: null,
        error: error.message,
      });
    }
  });
};
