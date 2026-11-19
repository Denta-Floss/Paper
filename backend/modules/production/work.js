'use strict';

const { withTransaction, withSavepoint } = require('../../kernel/db-kit');

// ---------------------------------------------------------------------------
// Production's work on a run: starting one, putting stock on a node and taking
// it back, a stage's numbers, scrap, finished output, a machine's queue and an
// item's history.
//
// These were the bodies of the fifteen handlers in routes.js, about nine
// hundred lines that could only be reached by being an HTTP request. They are
// here statement for statement. The one change is how each says what it has to
// say: instead of writing a response it returns answer(status, body), the same
// status and the same body. A function takes a plain `req` with `params`,
// `query`, `body` and `user`, which is all any of them ever read.
//
// ./operations.js publishes them at the kernel desk and turns an answer into a
// result; ./routes.js asks the desk and sends the result back as the answer it
// was. Nothing here knows about either.
// ---------------------------------------------------------------------------

const barcodes = require('../../kernel/barcodes');

function createProductionWork({
  actorFromRequest,
  all,
  challansPorts,
  get,
  getMaterialRowByBarcode,
  inventoryPorts,
  desk,
  itemsPorts,
  parseJson,
  recordLedgerEvent,
  rowToTemplate,
  run,
  production,
}) {
  /// What a handler used to send: the HTTP status and the JSON body.
  const answer = (status, body) => ({ status, body });

  // What production needs to know about its neighbours' records, asked of
  // their owners at the kernel desk rather than read from their tables.
  const templateRowById = async (id) => (await desk.ask('pipelines.templates.row', { id })).row;
  const itemRowById = async (id) => (await desk.ask('items.rows.get', { id })).row;
  const machineRowById = async (id) => (await desk.ask('machines.rows.get', { id })).row;
  const unitRowById = async (id) => (await desk.ask('units.rows.get', { id })).row;

  const {
    STAGE_RECON_COLUMNS,
    assignMaterialToRunNode,
    createRunFromTemplate,
    listCompletedProductionRuns,
    rowToRun,
    upsertStageReconciliation,
    setNodeStatus,
    orderForRun,
  } = production;

  async function completedOutput(req) {
    try {
      const runs = await listCompletedProductionRuns({
        search: req.query.search || req.query.q || '',
        limit: req.query.limit || 25,
      });
      return answer(200, { success: true, data: runs, productionRuns: runs, error: null });
    } catch (error) {
      return answer(error.statusCode || 500, {
        success: false,
        data: [],
        productionRuns: [],
        message: error.message,
        error: error.message,
      });
    }
  }

  // Machine queue: pending (non-terminal) pipeline runs assigned to this machine.
  // Assignment is read from the first-class run_machine_assignments table, falling
  // back to the template node machine + the name-keyed override for runs that
  // predate the assignment table.
  async function machineQueue(req) {
    try {
      const machine = await machineRowById(Number(req.params.id));
      if (!machine) {
        return answer(404, { success: false, queue: [], error: 'Machine not found.' });
      }
      const keys = new Set(
        [String(machine.id), machine.asset_id, machine.name]
          .filter(Boolean)
          .map((k) => String(k).trim()),
      );
      const assignedRunIds = new Set(
        (await all('SELECT DISTINCT run_id FROM run_machine_assignments WHERE machine_id = ?', [machine.id]))
          .map((r) => r.run_id),
      );
      const runRows = await all(`
        SELECT * FROM pipeline_runs
        WHERE status IN ('planned','in_progress','paused')
        ORDER BY created_at ASC
      `);
      const templateCache = new Map();
      const queue = [];
      for (const runRow of runRows) {
        let uses = assignedRunIds.has(runRow.id);
        if (!uses) {
          if (!templateCache.has(runRow.template_id)) {
            templateCache.set(
              runRow.template_id,
              await templateRowById(runRow.template_id),
            );
          }
          const nodes = parseJson(templateCache.get(runRow.template_id)?.nodes_json, []);
          const overrides = parseJson(runRow.overrides_json, {});
          const overrideNames = Object.values(overrides.machineOverrideByNode || {}).map((v) => String(v).trim());
          const nodeKeys = nodes.flatMap((n) =>
            [n.machineId, n.machine_id, n.machineAssetId, n.machine, n.machineName]
              .filter(Boolean)
              .map((k) => String(k).trim()),
          );
          uses = [...nodeKeys, ...overrideNames].some((k) => keys.has(k));
        }
        if (!uses) continue;
        let runDto = {};
        try {
          runDto = await rowToRun(runRow);
        } catch (_) {
          runDto = {};
        }
        queue.push({
          runId: runRow.id,
          runName: runRow.name || runDto.name || runRow.run_code || runRow.id,
          createdBy: runRow.created_by || null,
          clientName: runDto.clientName || '',
          orderNo: runDto.orderNo || '',
          weightKg: Number(runRow.weight_kg || 0),
          status: runRow.status,
        });
      }
      return answer(200, { success: true, queue, error: null });
    } catch (error) {
      return answer(500, { success: false, queue: [], error: error.message });
    }
  }

  async function deleteRun(req) {
    return withSavepoint(run, 'deleteRun', async () => {
    try {
      const existing = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
      if (!existing) {
        return answer(404, { success: false, error: 'Run not found.' });
        return;
      }
      await run('DELETE FROM run_barcode_inputs WHERE run_id = ?', [req.params.id]);
      await run('DELETE FROM production_scrap WHERE pipeline_run_id = ?', [req.params.id]);
      await run('DELETE FROM pipeline_runs WHERE id = ?', [req.params.id]);
      return answer(200, { success: true });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
    });
  }

  async function itemPipelineHistory(req) {
    try {
      const itemId = req.params.id;
      const item = await itemRowById(itemId);
      if (!item) {
        return answer(404, { success: false, error: 'Item not found', runs: [] });
        return;
      }

      // The runs made for this item's order lines, and, when the item has a
      // default pipeline, every run of that pipeline too.
      const lineIds = (await desk.ask('orders.lines.idsForItem', { itemId })).ids;
      const linked = lineIds.length
        ? `opa.order_item_id IN (${lineIds.map(() => '?').join(', ')})`
        : '0';
      let runRows = [];
      if (item.default_pipeline_id) {
        runRows = await all(
          `SELECT DISTINCT pr.* 
           FROM pipeline_runs pr
           LEFT JOIN order_pipeline_assignments opa ON pr.id = opa.pipeline_run_id
           WHERE pr.template_id = ? OR ${linked}
           ORDER BY pr.created_at DESC`,
          [item.default_pipeline_id, ...lineIds]
        );
      } else {
        runRows = await all(
          `SELECT DISTINCT pr.* 
           FROM pipeline_runs pr
           JOIN order_pipeline_assignments opa ON pr.id = opa.pipeline_run_id
           WHERE ${linked}
           ORDER BY pr.created_at DESC`,
          lineIds
        );
      }

      const runs = [];
      for (const row of runRows) {
        const run = await rowToRun(row);
        if (run) {
          const tmpl = await templateRowById(run.templateId);
          run.pipelineName = tmpl?.name || run.name || 'Production Pipeline';
          runs.push(run);
        }
      }

      return answer(200, {
        success: true,
        itemId: item.id,
        itemName: item.name || item.display_name,
        defaultPipelineId: item.default_pipeline_id,
        runs,
      });
    } catch (error) {
      return answer(500, { success: false, error: error.message, runs: [] });
    }
  }

  async function listRuns(req) {
    try {
      const { template_id: templateId } = req.query;
      const rows = templateId
        ? await all(
            'SELECT * FROM pipeline_runs WHERE template_id = ? ORDER BY created_at DESC',
            [templateId],
          )
        : await all('SELECT * FROM pipeline_runs ORDER BY created_at DESC');
      const runs = [];
      for (const row of rows) {
        runs.push(await rowToRun(row));
      }
      return answer(200, { success: true, runs });
    } catch (error) {
      return answer(500, { success: false, runs: [], error: error.message });
    }
  }

  async function startRun(req) {
    try {
      const {
        templateId,
        name,
        orderNo,
        orderItemId,
        scrapRouting,
        outputVariationLeafNodeId,
        outputVariationPathLabel,
      } = req.body || {};
      if (!templateId) {
        return answer(400, {
          success: false,
          run: null,
          error: 'templateId is required.',
        });
        return;
      }
      const run = await createRunFromTemplate(
        templateId,
        name,
        orderNo,
        orderItemId,
        scrapRouting || 'inventory',
        actorFromRequest(req),
        { outputVariationLeafNodeId, outputVariationPathLabel },
      );
      if (!run) {
        return answer(404, {
          success: false,
          run: null,
          error: 'Template not found.',
        });
        return;
      }
      return answer(201, { success: true, run });
    } catch (error) {
      return answer(500, { success: false, run: null, error: error.message });
    }
  }

  async function getRun(req) {
    try {
      const row = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
      if (!row) {
        return answer(404, { success: false, run: null, error: 'Run not found.' });
        return;
      }
      return answer(200, { success: true, run: await rowToRun(row) });
    } catch (error) {
      return answer(500, { success: false, run: null, error: error.message });
    }
  }

  async function setNodeStatusFor(req) {
    try {
      const result = await setNodeStatus({
        runId: req.params.id,
        payload: req.body || {},
        actor: actorFromRequest(req),
      });
      if (result.refusal) {
        return answer(result.refusal.status, result.refusal.body);
        return;
      }
      return answer(200, { success: true, run: result.run });
    } catch (error) {
      return answer(500, { success: false, run: null, error: error.message });
    }
  }

  async function assignStock(req) {
    return withSavepoint(run, 'assignStock', async () => {
    try {
      const runRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
      if (!runRow) {
        return answer(404, { success: false, run: null, error: 'Run not found.' });
        return;
      }

      const payload = req.body || {};

      // Consumption by quantity: an amount of an item+variation rather than a
      // piece you can scan. Stock that arrived on a challan as "300 kg of this
      // variation" has no barcode to point at, and refusing it here is what left
      // runs consuming material no record admits to.
      const quantityItemId = Number(payload.itemId ?? payload.item_id ?? 0);
      const quantityAmount = Number(payload.quantity ?? 0);
      if (!payload.barcode && quantityItemId > 0 && quantityAmount > 0) {
        if (!payload.nodeId) {
          return answer(400, { success: false, run: null, error: 'nodeId is required.' });
          return;
        }
        const leafNodeId =
          Number(payload.variationLeafNodeId ?? payload.variation_leaf_node_id ?? 0) || null;

        // A quantity is not a thing, but the stock it comes from is. When
        // barcodes hold this item and variation, the quantity has to name which
        // of them it comes from: the app lists them by name with a proposal
        // (oldest first) and the user approves a split. It is enforced here, so
        // no client can take stock without saying whose it was.
        const sources = await inventoryPorts.sources.forItem(quantityItemId, leafNodeId || 0);
        if (sources.length > 0) {
          const allocations = Array.isArray(payload.allocations)
            ? payload.allocations
                .map((entry) => ({
                  barcode: String(entry?.barcode || '').trim(),
                  quantity: Number(entry?.quantity || 0),
                }))
                .filter((entry) => entry.barcode && entry.quantity > 0)
            : [];
          if (allocations.length === 0) {
            return answer(409, {
              success: false,
              run: null,
              code: 'allocation_required',
              error: 'Choose which barcodes this quantity comes from.',
              sources,
              totalFree: sources.reduce((sum, source) => sum + source.free, 0),
              proposal: await inventoryPorts.sources.propose(sources, quantityAmount),
            });
            return;
          }
          // Checked whole before anything is written.
          const refuse = (message) => {
            return answer(400, { success: false, run: null, code: 'invalid_allocation', error: message });
          };
          const seen = new Set();
          let allocated = 0;
          for (const entry of allocations) {
            const source = sources.find((candidate) => candidate.barcode === entry.barcode);
            if (!source) {
              return refuse(`${entry.barcode} does not hold free stock of this item.`);
            }
            if (seen.has(entry.barcode)) {
              return refuse(`${entry.barcode} is listed twice.`);
            }
            seen.add(entry.barcode);
            if (entry.quantity > source.free + 1e-9) {
              return refuse(`${entry.barcode} has only ${source.free} free, not ${entry.quantity}.`);
            }
            allocated += entry.quantity;
          }
          if (Math.abs(allocated - quantityAmount) > 1e-6) {
            return refuse(`The barcodes add up to ${allocated}, but the quantity is ${quantityAmount}.`);
          }
          for (const entry of allocations) {
            await assignMaterialToRunNode({
              runId: req.params.id,
              payload: { nodeId: payload.nodeId, barcode: entry.barcode, quantity: entry.quantity },
              actorName: actorFromRequest(req)?.name || 'Floor',
            });
          }
          const allocatedRunRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
          return answer(200, { success: true, run: await rowToRun(allocatedRunRow), allocations });
          return;
        }

        // No barcode holds this item: its stock is only a figure on the item, so
        // the quantity comes off that figure. Refused when the item has less.
        await itemsPorts.stock.applyDelta({
          itemId: quantityItemId,
          variationLeafNodeId: leafNodeId || 0,
          delta: -quantityAmount,
        });
        const quantityInputId = `qty-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        await run(
          `
          INSERT INTO run_barcode_inputs (
            id, run_id, node_id, barcode, material_id, material_payload_json,
            scanned_at, challan_item_id, item_id, variation_leaf_node_id,
            consumed_qty, source_kind
          ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 'quantity')
          `,
          [
            quantityInputId,
            req.params.id,
            payload.nodeId,
            // Synthetic, so the row stays uniquely addressable and can never be
            // mistaken for — or collide with — a real barcode.
            `#qty-${quantityInputId}`,
            JSON.stringify({
              itemId: quantityItemId,
              variationLeafNodeId: leafNodeId,
              quantity: quantityAmount,
              // This row took the quantity off the item's stock, so removing or
              // changing it gives the difference back. Older rows took nothing.
              stockMoved: true,
            }),
            new Date().toISOString(),
            Number(payload.challanItemId ?? payload.challan_item_id ?? 0) || null,
            quantityItemId,
            leafNodeId,
            quantityAmount,
          ],
        );
        // Custody for stock issued by quantity rather than by piece.
        //
        // The subject is the ITEM, not the `#qty-…` sentinel written into
        // run_barcode_inputs. That sentinel is a row id, not a thing: nothing
        // carries it, nobody can scan it, and encoding it would put a code into
        // the ledger that resolves to nothing forever. Issuing 40kg off a coil is
        // a fact about the item, and that is what is recorded.
        await recordLedgerEvent({
          subjectBarcode: barcodes.encode('ITM', String(quantityItemId)),
          eventType: 'ISSUED_TO_PIPELINE',
          actorName: actorFromRequest(req)?.name || 'Floor',
          children: [barcodes.encode('RUN', req.params.id)].filter(Boolean),
          documentBarcode: Number(payload.challanItemId ?? payload.challan_item_id ?? 0)
            ? barcodes.encode('DCL', String(payload.challanItemId ?? payload.challan_item_id))
            : null,
          metrics: {
            qty: quantityAmount,
            nodeId: payload.nodeId,
            itemId: quantityItemId,
            variationLeafNodeId: leafNodeId,
            sourceKind: 'quantity',
          },
          notes: 'Issued by quantity',
        });

        const updatedRunRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [
          req.params.id,
        ]);
        return answer(200, { success: true, run: await rowToRun(updatedRunRow) });
        return;
      }

      if (!payload.nodeId || !payload.barcode) {
        return answer(400, {
          success: false,
          run: null,
          error: 'nodeId and barcode are required.',
        });
        return;
      }

      // Per-sheet lineage capture: if the scanned code is a vendor sheet tag
      // (piece_barcodes) rather than a SKU (materials), record the exact sheet
      // consumed so the run traces back to the original vendor sheet. Backward
      // compatible — SKU scans fall through to the unchanged path below.
      const sheet = await challansPorts.sheets.findByCode(payload.barcode);
      if (sheet) {
        const sheetInputId = `barcode-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        await run(
          `
          INSERT INTO run_barcode_inputs (
            id, run_id, node_id, barcode, material_id, material_payload_json,
            source_kind, piece_parent_code, piece_child_code, challan_item_id, consumed_weight, scanned_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'sheet', ?, ?, ?, ?, ?)
          `,
          [
            sheetInputId,
            req.params.id,
            payload.nodeId,
            sheet.parent_code,
            null,
            JSON.stringify({
              barcode: sheet.parent_code,
              materialName: 'Sheet',
              vendorId: sheet.vendor_id,
              vendorName: sheet.vendor_name,
              receptionChallanNo: sheet.reception_challan_no,
              sheetWeight: Number(sheet.weight || 0),
            }),
            sheet.parent_code,
            sheet.child_code,
            sheet.challan_item_id,
            Number(sheet.weight || 0),
            new Date().toISOString(),
          ],
        );
        // Roll the consumed sheet weight into the run's batch weight (surfaced in
        // the machine queue popup).
        await run(
          'UPDATE pipeline_runs SET weight_kg = COALESCE(weight_kg, 0) + ? WHERE id = ?',
          [Number(sheet.weight || 0), req.params.id],
        );

        // The sheet is part of the material its reception line became, so using
        // it takes that much off the material's stock. It used to take nothing:
        // inventory went on showing sheets that were already on the floor, and a
        // reception could be cancelled out from under a run.
        //
        // A weighed material loses the sheet's weight, a counted one loses one
        // piece. Never more than is on hand: stock that the books do not have
        // must not stop the floor from working, and the row then records what
        // was actually taken (0 means nothing was, and the reception's usage
        // still counts the sheet as claimed).
        const sheetStock = sheet.challan_item_id
          ? await inventoryPorts.receipts.materialForChallanLine(sheet.challan_item_id)
          : null;
        if (sheetStock) {
          const wanted = sheetStock.keptByWeight ? Number(sheet.weight || 0) : 1;
          const taken = Math.min(wanted, Math.max(0, Number(sheetStock.onHand || 0)));
          if (taken > 0) {
            await inventoryPorts.movements.applyCore({
              barcode: sheetStock.barcode,
              movementType: 'consume',
              qty: taken,
              actor: 'Floor Engineer',
              referenceType: 'pipeline_run',
              referenceId: req.params.id,
              reasonCode: 'PRODUCTION_ASSIGN',
            }, { useTransaction: false });
            await run(
              `UPDATE run_barcode_inputs
                  SET consumed_qty = ?,
                      material_payload_json = json_set(material_payload_json, '$.stockBarcode', ?, '$.stockQty', ?)
                WHERE id = ?`,
              [taken, sheetStock.barcode, taken, sheetInputId],
            );
          }
        }

        // The richest custody moment in the system, and it recorded nothing.
        //
        // This branch already holds the vendor, the reception challan and the
        // exact physical sheet — everything needed to answer "where did this come
        // from" — and it went straight into run_barcode_inputs without a word to
        // the ledger. Only the SKU branch emitted, so consuming material the way
        // a sheet-metal shop actually consumes it left a hole between the vendor
        // and the run.
        //
        // The subject is the challan LINE (DCL), because that is the identity the
        // sheet was received under and what a reception's trail already hangs off.
        // The vendor is the parent, so the walk reaches the outside world.
        await recordLedgerEvent({
          subjectBarcode: sheet.challan_item_id
            ? barcodes.encode('DCL', String(sheet.challan_item_id))
            : barcodes.normalize(sheet.parent_code || ''),
          eventType: 'ISSUED_TO_PIPELINE',
          actorName: actorFromRequest(req)?.name || 'Floor',
          parents: sheet.vendor_id
            ? [barcodes.encode('VEN', String(sheet.vendor_id))].filter(Boolean)
            : [],
          children: [barcodes.encode('RUN', req.params.id)].filter(Boolean),
          documentBarcode: sheet.reception_challan_no
            ? barcodes.encode('RC', sheet.reception_challan_no)
            : null,
          metrics: {
            weightKg: Number(sheet.weight || 0),
            nodeId: payload.nodeId,
            itemId: sheet.item_id || null,
            sourceKind: 'sheet',
            // Verbatim, because this is the code physically on the sheet and the
            // one someone will read back off it.
            pieceParentCode: sheet.parent_code || '',
            pieceChildCode: sheet.child_code || '',
            vendor: sheet.vendor_name || '',
            receptionChallanNo: sheet.reception_challan_no || '',
          },
          notes: sheet.vendor_name
            ? `Sheet from ${sheet.vendor_name}`
            : 'Vendor sheet',
        });
        const updatedRunRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [
          req.params.id,
        ]);
        return answer(200, { success: true, run: await rowToRun(updatedRunRow) });
        return;
      }

      await assignMaterialToRunNode({
        runId: req.params.id,
        payload,
        actorName: actorFromRequest(req)?.name || 'Floor',
      });

      const updatedRunRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [
        req.params.id,
      ]);
      return answer(200, { success: true, run: await rowToRun(updatedRunRow) });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, run: null, error: error.message });
    }
    });
  }

  async function changeStock(req) {
    return withSavepoint(run, 'changeStock', async () => {
    try {
      const runRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
      if (!runRow) {
        return answer(404, { success: false, run: null, error: 'Run not found.' });
        return;
      }

      const nodeId = req.params.nodeId || req.query.nodeId || req.body?.nodeId;
      const barcode = req.params.barcode || req.query.barcode || req.body?.barcode;
      const quantity = req.body?.quantity !== undefined && req.body.quantity !== null 
        ? Number(req.body.quantity) 
        : (req.query.quantity !== undefined && req.query.quantity !== null ? Number(req.query.quantity) : null);

      if (!nodeId || !barcode || quantity === null || isNaN(quantity)) {
        return answer(400, {
          success: false,
          run: null,
          error: 'nodeId, barcode, and valid quantity are required.',
        });
        return;
      }

      const existingInput = await get(
        'SELECT * FROM run_barcode_inputs WHERE run_id = ? AND node_id = ? AND barcode = ?',
        [req.params.id, nodeId, barcode]
      );

      if (!existingInput) {
        return answer(404, {
          success: false,
          run: null,
          error: 'Assigned stock not found for this node.',
        });
        return;
      }

      const materialPayload = JSON.parse(existingInput.material_payload_json || '{}');
      const oldQty = materialPayload.quantity !== undefined && materialPayload.quantity !== null 
        ? Number(materialPayload.quantity) 
        : 0;

      const qtyDiff = quantity - oldQty;

      if (existingInput.source_kind === 'sheet') {
        // Part of a sheet. `quantity` is how much of it was used, in the unit its
        // material is kept in. The sheet's stock came off the material its
        // reception line became, so the difference goes to or from that material,
        // not the sheet's own tag.
        const sheetStock = existingInput.challan_item_id
          ? await inventoryPorts.receipts.materialForChallanLine(existingInput.challan_item_id)
          : null;
        if (!sheetStock) {
          return answer(409, {
            success: false,
            run: null,
            error: 'This sheet has no stock behind it to adjust.',
          });
          return;
        }
        if (!sheetStock.keptByWeight) {
          return answer(400, {
            success: false,
            run: null,
            error: 'This material is counted in pieces, and a sheet is one piece. Remove the sheet instead.',
          });
          return;
        }
        const sheetWeight = Number(materialPayload.sheetWeight || 0);
        if (!(quantity > 0) || quantity > sheetWeight + 1e-9) {
          return answer(400, {
            success: false,
            run: null,
            error: `The used weight must be above zero and no more than the sheet's ${sheetWeight}.`,
          });
          return;
        }
        const takenBefore = Number(materialPayload.stockQty || 0);
        const stockDiff = quantity - takenBefore;
        if (stockDiff !== 0) {
          await inventoryPorts.movements.applyCore({
            barcode: sheetStock.barcode,
            movementType: stockDiff > 0 ? 'consume' : 'adjust',
            qty: Math.abs(stockDiff),
            actor: 'Floor Engineer',
            referenceType: 'pipeline_run',
            referenceId: req.params.id,
            reasonCode: 'PRODUCTION_ASSIGN_UPDATE',
          }, { useTransaction: false });
        }
        const weightBefore = Number(existingInput.consumed_weight || 0);
        materialPayload.stockBarcode = sheetStock.barcode;
        materialPayload.stockQty = quantity;
        materialPayload.quantity = quantity;
        materialPayload.unit = sheetStock.uom;
        await run(
          'UPDATE run_barcode_inputs SET material_payload_json = ?, consumed_qty = ?, consumed_weight = ? WHERE id = ?',
          [JSON.stringify(materialPayload), quantity, quantity, existingInput.id],
        );
        // The run's batch weight was raised by the whole sheet when it was scanned.
        await run(
          'UPDATE pipeline_runs SET weight_kg = MAX(0, COALESCE(weight_kg, 0) + ?) WHERE id = ?',
          [quantity - weightBefore, req.params.id],
        );
        const sheetRunRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
        return answer(200, { success: true, run: await rowToRun(sheetRunRow) });
        return;
      }

      if (existingInput.source_kind === 'quantity') {
        // Not a material: the row stands for an amount of the item itself.
        if (!(quantity > 0)) {
          return answer(400, { success: false, run: null, error: 'Quantity must be above zero. Remove the row instead.' });
          return;
        }
        if (materialPayload.stockMoved && qtyDiff !== 0) {
          await itemsPorts.stock.applyDelta({
            itemId: existingInput.item_id,
            variationLeafNodeId: existingInput.variation_leaf_node_id || 0,
            delta: -qtyDiff,
          });
        }
        materialPayload.quantity = quantity;
        await run(
          'UPDATE run_barcode_inputs SET material_payload_json = ?, consumed_qty = ? WHERE id = ?',
          [JSON.stringify(materialPayload), quantity, existingInput.id],
        );
        const quantityRunRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
        return answer(200, { success: true, run: await rowToRun(quantityRunRow) });
        return;
      }

      if (qtyDiff > 0) {
        await inventoryPorts.movements.applyCore({
          barcode: barcode,
          movementType: 'consume',
          qty: qtyDiff,
          actor: 'Floor Engineer',
          referenceType: 'pipeline_run',
          referenceId: req.params.id,
          reasonCode: 'PRODUCTION_ASSIGN_UPDATE',
        }, { useTransaction: false });
      } else if (qtyDiff < 0) {
        await inventoryPorts.movements.applyCore({
          barcode: barcode,
          movementType: 'adjust',
          qty: -qtyDiff,
          actor: 'Floor Engineer',
          referenceType: 'pipeline_run',
          referenceId: req.params.id,
          reasonCode: 'PRODUCTION_ASSIGN_UPDATE',
        }, { useTransaction: false });
      }

      materialPayload.quantity = quantity;
      await run(
        'UPDATE run_barcode_inputs SET material_payload_json = ? WHERE id = ?',
        [JSON.stringify(materialPayload), existingInput.id]
      );

      const updatedRunRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
      return answer(200, { success: true, run: await rowToRun(updatedRunRow) });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, run: null, error: error.message });
    }
    });
  }

  async function removeStock(req) {
    return withSavepoint(run, 'removeStock', async () => {
    try {
      const runRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
      if (!runRow) {
        return answer(404, { success: false, run: null, error: 'Run not found.' });
        return;
      }

      const nodeId = req.params.nodeId || req.query.nodeId || req.body?.nodeId;
      const barcode = req.params.barcode || req.query.barcode || req.body?.barcode;

      if (!nodeId || !barcode) {
        return answer(400, {
          success: false,
          run: null,
          error: 'nodeId and barcode are required.',
        });
        return;
      }

      const existingInput = await get(
        'SELECT * FROM run_barcode_inputs WHERE run_id = ? AND node_id = ? AND barcode = ?',
        [req.params.id, nodeId, barcode]
      );

      if (!existingInput) {
        return answer(404, {
          success: false,
          run: null,
          error: 'Assigned stock not found for this node.',
        });
        return;
      }

      const materialPayload = JSON.parse(existingInput.material_payload_json || '{}');
      const oldQty = materialPayload.quantity !== undefined && materialPayload.quantity !== null 
        ? Number(materialPayload.quantity) 
        : 0;

      if (existingInput.source_kind === 'quantity') {
        // Not a material: give the amount back to the item's own stock, when
        // this row took it from there.
        if (materialPayload.stockMoved && oldQty > 0) {
          await itemsPorts.stock.applyDelta({
            itemId: existingInput.item_id,
            variationLeafNodeId: existingInput.variation_leaf_node_id || 0,
            delta: oldQty,
          });
        }
        await run('DELETE FROM run_barcode_inputs WHERE id = ?', [existingInput.id]);
        const quantityRunRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
        return answer(200, { success: true, run: await rowToRun(quantityRunRow) });
        return;
      }

      // A sheet's code is not a material; its stock is given back just below,
      // to the material it was taken from.
      if (oldQty > 0 && existingInput.source_kind !== 'sheet') {
        await inventoryPorts.movements.applyCore({
          barcode: barcode,
          movementType: 'adjust',
          qty: oldQty,
          actor: 'Floor Engineer',
          referenceType: 'pipeline_run',
          referenceId: req.params.id,
          reasonCode: 'PRODUCTION_ASSIGN_DELETE',
        }, { useTransaction: false });
      }

      // A sheet took its stock off the material its reception line became, not
      // off its own code, so taking the sheet back off the run returns it there.
      const sheetStockQty = Number(materialPayload.stockQty || 0);
      if (materialPayload.stockBarcode && sheetStockQty > 0) {
        await inventoryPorts.movements.applyCore({
          barcode: materialPayload.stockBarcode,
          movementType: 'adjust',
          qty: sheetStockQty,
          actor: 'Floor Engineer',
          referenceType: 'pipeline_run',
          referenceId: req.params.id,
          reasonCode: 'PRODUCTION_ASSIGN_DELETE',
        }, { useTransaction: false });
      }

      await run(
        'DELETE FROM run_barcode_inputs WHERE id = ?',
        [existingInput.id]
      );

      // Recompute AFTER the row is gone so linked_pipeline_count (and the
      // "in pipeline" headband) reflects the detachment. Any movement above ran
      // while the row still existed, so it would have counted the stale row.
      await inventoryPorts.ledger.recomputeSummary(barcode);

      const updatedRunRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
      return answer(200, { success: true, run: await rowToRun(updatedRunRow) });
    } catch (error) {
      return answer(error.statusCode || 500, { success: false, run: null, error: error.message });
    }
    });
  }

  async function setNodeMetrics(req) {
    return withSavepoint(run, 'setNodeMetrics', async () => {
    try {
      const { nodeId, metrics } = req.body;
      if (!nodeId || !metrics) {
        return answer(400, { success: false, run: null, error: 'nodeId and metrics are required.' });
      }
      const runRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
      if (!runRow) {
        return answer(404, { success: false, run: null, error: 'Run not found.' });
      }

      // Read before the upsert overwrites it, so the event can say whether this
      // was the stage being reconciled or the numbers being corrected — and so a
      // re-save that changes nothing writes nothing.
      //
      // This matters because stage_reconciliations is an UPSERT keyed on
      // (run_id, node_id) and converges to one row, while the ledger is
      // append-only. Without this, a supervisor who opens the dialog, looks, and
      // closes it leaves a permanent event saying the stage was processed again.
      // A genuine correction IS worth recording — it is a real thing that
      // happened on the floor — so it is kept and marked, not suppressed.
      const priorStage = await get(
        'SELECT * FROM stage_reconciliations WHERE run_id = ? AND node_id = ?',
        [req.params.id, nodeId],
      );

      await upsertStageReconciliation(req.params.id, nodeId, metrics);

      const stageChanged = !priorStage
        || Object.entries(STAGE_RECON_COLUMNS).some(([key, column]) => {
          if (metrics[key] === undefined) return false;
          const before = priorStage[column];
          const after = metrics[key];
          // Loose comparison on purpose: the column may hold 5 where the payload
          // sends '5', and a formatting difference is not a shop-floor event.
          if (before === null || before === undefined) return after !== null && after !== undefined;
          return String(before) !== String(after);
        });

      // Two different clients PUT to this route and they mean different things.
      // The Stage Reconciliation dialog sends the whole booking — allotted, output,
      // scrap, leftover, inputTime, outputTime — which IS the floor declaring the
      // stage worked. The inline metric box sends a single key ({output: 4}) and
      // never a timestamp; that is someone correcting a number.
      //
      // So a full booking is always the stage being processed, and a single-key
      // edit only counts once the stage has actually been booked — otherwise
      // typing one number into a stage nobody has run would write, permanently,
      // that it was processed.
      const isFullBooking = metrics.outputTime !== undefined;
      if (stageChanged && (isFullBooking || priorStage)) {
        const stageOrder = await orderForRun(req.params.id);
        const stageInputs = await all(
          'SELECT DISTINCT barcode FROM run_barcode_inputs WHERE run_id = ? AND node_id = ?',
          [req.params.id, nodeId],
        );
        // The RUN is the subject, not the materials. The payload is a stage
        // aggregate — 5.5kg allotted, 5 out, 0.2 scrap — and nothing splits those
        // numbers per input. Copying one aggregate onto three scanned barcodes
        // would write three rows each claiming the stage produced 5, into a table
        // that cannot be corrected. The materials are named as parents instead,
        // and loadCustody matches on parents, so scanning one still surfaces this.
        await recordLedgerEvent({
          subjectBarcode: barcodes.encode('RUN', req.params.id),
          eventType: 'STAGE_PROCESSED',
          actorName: actorFromRequest(req)?.name || 'Floor',
          parents: stageInputs
            .map((row) => barcodes.encode('MAT', row.barcode))
            .filter(Boolean),
          orderBarcode: stageOrder?.order_no
            ? barcodes.encode('ORD', stageOrder.order_no)
            : null,
          metrics: {
            nodeId,
            allotted: metrics.allotted ?? null,
            output: metrics.output ?? null,
            scrap: metrics.scrap ?? null,
            leftover: metrics.remaining ?? null,
            actualHours: metrics.actualHours ?? null,
            inputTime: metrics.inputTime || null,
            outputTime: metrics.outputTime || null,
            revised: Boolean(priorStage),
          },
          notes: priorStage ? `Stage ${nodeId} revised` : `Stage ${nodeId}`,
        });
      }

      // Auto-generate internal challan for leftover if remaining is specified
      if (metrics.remaining !== undefined) {
        const runId = req.params.id;
        const sourceRef = `Leftover/Run ${runId}/Node ${nodeId}`;
      
        // Find input item for this node
        let itemId = null;
        const templateRow = await templateRowById(runRow.template_id);
        if (templateRow) {
          const tpl = rowToTemplate(templateRow);
          const node = tpl.nodes.find(n => n.id === nodeId);
          const inName = node && node.inputs && node.inputs[0];
          if (inName) {
            const matched = await itemsPorts.lookupByName(inName);
            if (matched) itemId = matched.id;
          }
        }
      
        if (itemId) {
          const existingChallan = await challansPorts.stageNotes.find(sourceRef);
          if (existingChallan) {
            if (Number(metrics.remaining) > 0) {
              await challansPorts.stageNotes.setQuantity(existingChallan.id, metrics.remaining);
            } else {
              // If they set it back to 0, the note goes.
              await challansPorts.stageNotes.remove(existingChallan.id);
            }
          } else if (Number(metrics.remaining) > 0) {
            await challansPorts.stageNotes.create({
              sourceReference: sourceRef,
              kind: 'leftover',
              itemId,
              quantity: metrics.remaining,
            });
          }
        }
      }

      return answer(200, { success: true, run: await rowToRun(runRow) });
    } catch (error) {
      return answer(500, { success: false, run: null, error: error.message });
    }
    });
  }

  async function setBatches(req) {
    try {
      const { batches } = req.body;
      if (!Array.isArray(batches)) {
        return answer(400, { success: false, run: null, error: 'batches array is required.' });
      }
      const runRow = await get('SELECT id FROM pipeline_runs WHERE id = ?', [req.params.id]);
      if (!runRow) {
        return answer(404, { success: false, run: null, error: 'Run not found.' });
      }
      await run('UPDATE pipeline_runs SET batches_json = ? WHERE id = ?', [
        JSON.stringify(batches),
        req.params.id,
      ]);
      const updatedRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [req.params.id]);
      return answer(200, { success: true, run: await rowToRun(updatedRow) });
    } catch (error) {
      return answer(500, { success: false, run: null, error: error.message });
    }
  }

  async function recordScrap(req) {
    return withSavepoint(run, 'recordScrap', async () => {
    try {
      const { pipelineRunId, nodeId, orderNo, materialBarcode, scrapQty, scrapItemId, scrapItemName } = req.body;
      if (!pipelineRunId || !nodeId || !materialBarcode) {
        return answer(400, { success: false, error: 'pipelineRunId, nodeId, and materialBarcode are required.' });
      }

      // First log to legacy production_scrap table
      await run(`
        INSERT INTO production_scrap (pipeline_run_id, node_id, order_no, material_barcode, scrap_qty, logged_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [pipelineRunId, nodeId, orderNo, materialBarcode, scrapQty, actorFromRequest(req)]);

      // Check pipeline for targeted scrap routing group
      const runRow = await get('SELECT scrap_routing FROM pipeline_runs WHERE id = ?', [pipelineRunId]);
      const scrapRoutingGroupId = runRow?.scrap_routing && runRow.scrap_routing !== 'inventory' ? runRow.scrap_routing : null;

      // Bridge to actual inventory. The stage's chosen Scrap-group item (set in
      // the pipeline builder) wins: the lot is linked to that item and named per
      // order, so each order's scrap shows as its own entry under the item.
      // Without a scrap item we fall back to the legacy source-material link.
      let scrapItem = null;
      if (scrapItemId) {
        const scrapRow = await itemRowById(Number(scrapItemId));
        if (scrapRow) {
          const unit = scrapRow.unit_id ? await unitRowById(scrapRow.unit_id) : null;
          scrapItem = {
            id: scrapRow.id,
            name: scrapRow.name,
            display_name: scrapRow.display_name,
            unit_id: scrapRow.unit_id,
            unit_symbol: unit ? unit.symbol : null,
          };
        }
      } else if (scrapItemName) {
        scrapItem = await itemsPorts.lookupByName(scrapItemName);
        if (scrapItem) {
          const unit = await unitRowById(scrapItem.unit_id);
          scrapItem.unit_symbol = unit?.symbol;
        }
      }
      const sourceMaterial = await getMaterialRowByBarcode(materialBarcode);
      if ((scrapItem || sourceMaterial) && Number(scrapQty) > 0) {
        const actor = actorFromRequest(req);
        const newLotBarcode = `LOT-SCRAP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const lotName = scrapItem
          ? `${scrapItemName || scrapItem.display_name || scrapItem.name} - ${orderNo || pipelineRunId}`
          : `Scrap - ${sourceMaterial.name}`;
        const lotUnit = sourceMaterial?.unit || scrapItem?.unit_symbol || 'pcs';

        await inventoryPorts.receipts.mintLot({
          barcode: newLotBarcode,
          name: lotName,
          type: sourceMaterial?.type ?? 'Scrap',
          groupId: scrapRoutingGroupId ? Number(scrapRoutingGroupId) : null,
          itemId: scrapItem ? scrapItem.id : sourceMaterial.linked_item_id,
          leafNodeId: scrapItem ? null : sourceMaterial.linked_variation_leaf_node_id,
          unit: lotUnit,
          unitId: sourceMaterial?.unit_id ?? scrapItem?.unit_id ?? null,
          createdAt: new Date().toISOString(),
        });

        await inventoryPorts.movements.applyCore({
          barcode: newLotBarcode,
          movementType: 'receive',
          qty: Number(scrapQty),
          primaryQty: Number(scrapQty),
          uom: lotUnit,
          toLocationId: 'SCRAP-BIN',
          reasonCode: 'production_scrap',
          referenceType: 'pipeline_scrap',
          referenceId: pipelineRunId,
          actor: actor?.id || null,
          lotCode: newLotBarcode,
        }, { useTransaction: false });

        // An internal note for the scrap, so it appears in the challan ledger.
        await challansPorts.stageNotes.create({
          sourceReference: `Scrap/Run ${pipelineRunId}/Node ${nodeId}`,
          kind: 'scrap',
          itemId: scrapItem ? scrapItem.id : sourceMaterial.linked_item_id,
          quantity: scrapQty,
        });
      }

      return answer(201, { success: true });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
    });
  }

  async function listScrap(req) {
    try {
      const { pipelineRunId, nodeId } = req.query;
      let query = 'SELECT * FROM production_scrap WHERE 1=1';
      const params = [];
      if (pipelineRunId) {
        query += ' AND pipeline_run_id = ?';
        params.push(pipelineRunId);
      }
      if (nodeId) {
        query += ' AND node_id = ?';
        params.push(nodeId);
      }
      query += ' ORDER BY created_at DESC';
      const rows = await all(query, params);
      return answer(200, { success: true, data: rows });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  return {
    completedOutput,
    machineQueue,
    deleteRun,
    itemPipelineHistory,
    listRuns,
    startRun,
    getRun,
    setNodeStatusFor,
    assignStock,
    changeStock,
    removeStock,
    setNodeMetrics,
    setBatches,
    recordScrap,
    listScrap,
  };
}

module.exports = { createProductionWork };
