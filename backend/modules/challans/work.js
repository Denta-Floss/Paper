'use strict';

// ---------------------------------------------------------------------------
// The challan itself: list, read, create, edit, issue, reconcile, cancel, print, delete, its piece barcodes and its photos.
//
// These were the bodies of the handlers in routes.js, here statement for
// statement. Instead of writing a response each returns answer(status, body)
// (or answerFile for a PDF): the same status, the same body. A function takes a
// plain `req` with `params`, `query`, `body` and `user`.
//
// ./operations.js publishes them at the kernel desk; ./routes.js asks the
// desk and sends the result back as the answer it was.
// ---------------------------------------------------------------------------

const { answer, answerFile } = require('../../kernel/desk-kit');

function createChallanWork({
  challanService,
  get,
  all,
  run,
  nowIso,
  rowToUploadedAssetDto,
  normalizeChallanType,
  createAssetUploadIntent,
  completeAssetUpload,
  inventoryPorts,
  actorFromRequest,
  ensureReconcilePrimaryGroup,
  ensureReconcileSubGroup,
  ensureReconcileItem,
  desk,
}) {

  /// An item with its unit's symbol, asked of items and units.
  async function itemWithUnit(itemId) {
    const { row: item } = await desk.ask('items.rows.get', { id: itemId });
    if (!item) return null;
    const unit = item.unit_id ? (await desk.ask('units.rows.get', { id: item.unit_id })).row : null;
    return {
      id: item.id,
      name: item.name,
      display_name: item.display_name,
      unit_id: item.unit_id,
      unit_symbol: unit ? unit.symbol : null,
    };
  }

  async function handleListChallans(req) {
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
      return answer(200, { success: true, data: challans, error: null });
    } catch (error) {
      return answer(500, { success: false, data: [], message: error.message, error: error.message });
    }
  }



  async function handleCreateChallan(req) {
    try {
      const challan = await challanService.saveDeliveryChallan(req.body || {}, actorFromRequest(req), req);
      const warning = await challanService.challanNumberWarning(
        req.body?.challanNo ?? req.body?.challan_no,
        challan.type,
      );
      const challanDto = await challanService.rowToDeliveryChallanDto(challan);
      return answer(201, {
        success: true,
        data: challanDto,
        warnings: warning ? [warning] : [],
        error: null,
      });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }



  // Persist the piece/sheet barcodes generated on the mobile wizard's Done step,
  // after the challan (and its number) already exist. Kept separate from the
  // challan upsert because that path deletes-and-reinserts every item (cascade-
  // wiping barcodes and re-running issuance). Idempotent: replaces the barcodes
  // for each referenced item, so re-generating or re-printing is safe.
  async function addPieceBarcodes(req) {
    try {
      const challanId = Number(req.params.id);
      if (!Number.isInteger(challanId) || challanId <= 0) {
        return answer(400, { success: false, data: null, error: 'Invalid challan id.' });
      }
      const challan = await get('SELECT id FROM delivery_challans WHERE id = ?', [challanId]);
      if (!challan) {
        return answer(404, { success: false, data: null, error: 'Challan not found.' });
      }

      const incoming = Array.isArray(req.body?.barcodes) ? req.body.barcodes : [];
      const itemRows = await all('SELECT id FROM delivery_challan_items WHERE challan_id = ?', [challanId]);
      const validItemIds = new Set(itemRows.map((row) => row.id));

      const clean = [];
      const touchedItemIds = new Set();
      for (const pb of incoming) {
        const itemId = Number(pb.challanItemId ?? pb.challan_item_id);
        if (!validItemIds.has(itemId)) {
          return answer(400, {
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
      return answer(200, { success: true, data: dto, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }

  async function listForOrder(req) {
    try {
      const orderId = Number(req.params.orderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return answer(400, {
          success: false,
          data: [],
          message: 'Invalid order id.',
          error: 'Invalid order id.',
        });
        return;
      }
      const challans = await challanService.listDeliveryChallans({ orderId, type: 'delivery' });
      return answer(200, { success: true, data: challans, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: [],
        message: error.message,
        error: error.message,
      });
    }
  }

  async function handleGetChallan(req) {
    try {
      const challan = await challanService.getDeliveryChallanRowById(Number(req.params.id));
      if (!challan) {
        return answer(404, {
          success: false,
          data: null,
          message: 'Challan not found.',
          error: 'Challan not found.',
        });
        return;
      }
      return answer(200, { success: true, data: await challanService.rowToDeliveryChallanDto(challan), error: null });
    } catch (error) {
      return answer(500, { success: false, data: null, message: error.message, error: error.message });
    }
  }



  async function handleUpdateChallan(req) {
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
      return answer(200, {
        success: true,
        data: await challanService.rowToDeliveryChallanDto(challan),
        warnings: warning ? [warning] : [],
        error: null,
      });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }



  async function handleIssueChallan(req) {
    try {
      const challan = await challanService.issueDeliveryChallan(Number(req.params.id), actorFromRequest(req));
      const sent = answer(200, { success: true, data: await challanService.rowToDeliveryChallanDto(challan), error: null });
      return sent;
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }



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

  async function handleReconcileChallan(req) {
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
      const kgUnitId = (await desk.ask('units.ensureKilogram')).unitId;
      const dateStr = new Date().toISOString().slice(0, 10);
      const breakdown = [];
      const affectedItemIds = new Set();
      const subGroupCache = new Map();

      await run('BEGIN TRANSACTION');
      try {
        for (const entry of plan) {
          const { item, amounts, taken } = entry;
          const sourceItem = item.item_id ? await itemWithUnit(Number(item.item_id)) : null;
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
            // Inside this settle's transaction, so the item save must not open
            // its own: SQLite has no nested BEGIN. This is what made every
            // settle fail when the scrap item was new.
            const reconItemId = await ensureReconcileItem(reconItemName, subGroupId, unitId, { useTransaction: false });
            affectedItemIds.add(reconItemId);

            const lotBarcode = `LOT-RECON-${challanId}-${bucket.prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            await inventoryPorts.receipts.mintReconcileLot({
              lotBarcode,
              name: reconItemName,
              groupId: subGroupId,
              itemId: reconItemId,
              unitSymbol,
              unitId,
              createdAt: nowIso(),
            });

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
          const orderItems = (await desk.ask('orders.lines.idsForOrderNo', { orderNo })).ids.map((id) => ({ id }));
          for (const orderItem of orderItems) {
            const done = await challanService.completeOrderItemBestEffort(orderItem.id, actor);
            if (done) completedOrderIds.push(orderItem.id);
          }
        }
      }

      const updatedRow = await challanService.getDeliveryChallanRowById(challanId);
      const dto = await challanService.rowToDeliveryChallanDto(updatedRow);
      return answer(200, {
        success: true,
        data: dto,
        reconciliation: { breakdown, completedOrderIds },
        error: null,
      });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }



  async function handleGetCancelOptions(req) {
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
      return answer(200, { success: true, challanId: id, linkedInvoices: invoices, availableActions: actions, error: null });
    } catch (error) {
      return answer(500, { success: false, data: null, message: error.message, error: error.message });
    }
  }

  async function handleCancelChallan(req) {
    try {
      const id = Number(req.params.id);
      const { action } = req.body;
      let dropInvoiceIds = [];
    
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
          dropInvoiceIds = invoices.map((draft) => draft.id);
        } else {
          const err = new Error('Invalid cancel action.');
          err.statusCode = 400;
          throw err;
        }
      }

      const challan = await challanService.cancelDeliveryChallan(id, actorFromRequest(req), { dropInvoiceIds });
      // A partly used reception is not cancelled: a draft vendor return is
      // made for what is free, and the answer says so.
      const returnRow = challan.returnChallanRow || null;
      const sent = answer(200, {
        success: true,
        data: await challanService.rowToDeliveryChallanDto(challan),
        ...(returnRow
          ? {
              outcome: 'return_challan_created',
              message: challan.cancelNotice,
              returnChallan: await challanService.rowToDeliveryChallanDto(returnRow),
            }
          : {}),
        error: null,
      });

      return sent;
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }





  async function handleUpdateChallanReportGroups(req) {
    try {
      const challanId = Number(req.params.id);
      const existing = await challanService.getDeliveryChallanRowById(challanId);
      if (!existing) {
        return answer(404, {
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
      return answer(200, {
        success: true,
        data: await challanService.rowToDeliveryChallanDto(refreshed),
        error: null,
      });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }



  async function handlePrintChallan(req) {
    try {
      const challan = await challanService.getDeliveryChallanRowById(Number(req.params.id));
      if (!challan) {
        return answer(404, {
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
      return answer(200, { success: true, data: null, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }



  async function handleDeleteChallan(req) {
    try {
      await challanService.deleteDraftDeliveryChallan(Number(req.params.id), actorFromRequest(req));
      return answer(200, { success: true, data: null, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: null,
        message: error.message,
        error: error.message,
      });
    }
  }



  async function assetUploadIntent(req) {
    try {
      const entityId = Number(req.params.id);
      if (!Number.isInteger(entityId) || entityId <= 0) {
        return answer(400, {
          success: false,
          intent: null,
          error: 'A valid challan id is required.',
        });
        return;
      }
      const requestedEntityId = req.body?.entityId;
      if (requestedEntityId != null && Number(requestedEntityId) !== entityId) {
        return answer(400, {
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
      return answer(intent.alreadyUploaded ? 200 : 201, {
        success: true,
        intent,
        error: null,
      });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        intent: null,
        error: error.message,
      });
    }
  }

  async function assetUploadComplete(req) {
    try {
      const entityId = Number(req.params.id);
      if (!Number.isInteger(entityId) || entityId <= 0) {
        return answer(400, {
          success: false,
          asset: null,
          error: 'A valid challan id is required.',
        });
        return;
      }
      const requestedEntityId = req.body?.entityId;
      if (requestedEntityId != null && Number(requestedEntityId) !== entityId) {
        return answer(400, {
          success: false,
          asset: null,
          error: 'Request challan id does not match the upload route challan id.',
        });
        return;
      }
      // The session has to be one that was opened for THIS challan; completing
      // someone else's upload through this address would file it under theirs.
      const { row: session } = await desk.ask('assets.sessionEntity', { id: String(req.body?.uploadSessionId || '') });
      if (session && (session.entity_type !== 'delivery_challan' || Number(session.entity_id) !== entityId)) {
        return answer(400, {
          success: false,
          asset: null,
          error: 'That upload does not belong to this challan.',
        });
        return;
      }
      // The same function every other record's upload-complete uses. This route
      // used to call a helper that did not exist, so it always failed.
      const assetDto = await completeAssetUpload({
        uploadSessionId: req.body?.uploadSessionId,
        objectKey: req.body?.objectKey,
      });
      return answer(200, {
        success: true,
        asset: assetDto,
        error: null,
      });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        asset: null,
        error: error.message,
      });
    }
  }

  return {
    addPieceBarcodes,
    listForOrder,
    assetUploadIntent,
    assetUploadComplete,
    handleListChallans,
    handleCreateChallan,
    handleGetChallan,
    handleUpdateChallan,
    handleIssueChallan,
    handleReconcileChallan,
    handleCancelChallan,
    handleGetCancelOptions,
    handleUpdateChallanReportGroups,
    handlePrintChallan,
    handleDeleteChallan,
  };
}

module.exports = { createChallanWork };
