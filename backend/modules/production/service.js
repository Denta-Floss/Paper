'use strict';

// ---------------------------------------------------------------------------
// Production: runs on the floor and what they leave behind.
//
// A pipeline run is one pass of a template: a status per node, the stock put
// on each node, the numbers a stage was reconciled with, and, when every node
// is done, the output booked as a production run and a lot in inventory.
//
//   reading   rowToRun (a run with its inputs, metrics and order), the
//             completed production runs, one production run by id
//   making    createRunFromTemplate, ensurePipelineRunRecord (an order's run)
//   stages    upsertStageReconciliation, getMergedNodeMetrics, and the
//             temporary set an Assembly stage produces
//   stock     assignMaterialToRunNode: one material put on a node
//
// Other modules are reached through what is handed in: inventory through its
// port, the job pool through the jobs service, templates through the pipelines
// service. Functions moved whole from server.js.
// ---------------------------------------------------------------------------

const barcodes = require('../../kernel/barcodes');

function createProductionService({
  all,
  get,
  getItemSelectionSnapshot,
  getMaterialRowByBarcode,
  inventoryPorts,
  itemsPorts,
  desk,
  jobsService,
  parseJson,
  recordLedgerEvent,
  rowToMaterialDto,
  rowToTemplate,
  run,
}) {
  /// A pipeline template's row. Templates are the pipelines module's; a run
  /// only remembers which one it was started from.
  const templateRowById = async (id) => (await desk.ask('pipelines.templates.row', { id })).row;

  // Metric key (API/blob) → stage_reconciliations column. One row per run+node;
  // the API keeps exposing these as `nodeMetrics` so the app needs no changes.
  const STAGE_RECON_COLUMNS = {
    allotted: 'allotted',
    output: 'output',
    remaining: 'leftover',
    scrap: 'scrap',
    goodYield: 'good_yield',
    actualHours: 'actual_hours',
    scrapItemId: 'scrap_item_id',
    scrapItem: 'scrap_item_name',
    leftoverAction: 'leftover_action',
    inputTime: 'input_time',
    outputTime: 'output_time',
  };

  async function upsertStageReconciliation(runId, nodeId, metrics) {
    const cols = [];
    const vals = [];
    for (const [key, col] of Object.entries(STAGE_RECON_COLUMNS)) {
      if (metrics[key] !== undefined) {
        cols.push(col);
        vals.push(metrics[key]);
      }
    }
    if (!cols.length) return;
    await run(
      `INSERT INTO stage_reconciliations (run_id, node_id, ${cols.join(', ')}, updated_at)
       VALUES (?, ?, ${cols.map(() => '?').join(', ')}, datetime('now'))
       ON CONFLICT(run_id, node_id) DO UPDATE SET
         ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
         updated_at = excluded.updated_at`,
      [runId, nodeId, ...vals],
    );
    await jobsService.propagateAssemblyRejection(runId, nodeId, metrics);
    // Reconciling an assembly stage is the moment its output is real, so that is
    // when the temporary set lands in inventory.
    if (metrics.output !== undefined && metrics.output !== null) {
      try {
        await ensureTemporarySetFromAssembly(runId, nodeId, Number(metrics.output) || 0);
      } catch (error) {
        // A set that cannot be minted must not fail the supervisor's booking.
        console.warn(`[assembly-set] run ${runId} node ${nodeId}: ${error.message}`);
      }
    }
  }

  /**
   * An assembly step clips parts together, and the result is a set. Mint it into
   * inventory the way a run mints a temporary item: composition taken from what
   * actually fed the step on this run, then matched against the defined sets so a
   * recognised composition carries that set's name.
   *
   * Keyed on (run, node) — reconciling the same stage again updates the set it
   * already produced rather than minting a second one.
   */
  async function ensureTemporarySetFromAssembly(runId, nodeId, producedQty) {
    const runRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [runId]);
    if (!runRow) return null;
    const templateRow = await templateRowById(runRow.template_id);
    if (!templateRow) return null;
    const tpl = rowToTemplate(templateRow);
    const node = (tpl.nodes || []).find((n) => n.id === nodeId);
    if (!node || node.processType !== 'Assembly') return null;

    // What fed the step is what got assembled.
    const feederIds = new Set(
      (tpl.flows || []).filter((f) => f.toNodeId === nodeId).map((f) => f.fromNodeId),
    );
    const overrides = parseJson(runRow.overrides_json, { batchQuantityByNode: {} });
    const lines = [];
    for (const feeder of (tpl.nodes || [])) {
      if (!feederIds.has(feeder.id)) continue;
      const itemId = feeder.outputItem && feeder.outputItem.itemId;
      if (!itemId) continue;
      lines.push({
        itemId,
        leafId: feeder.outputItem.variationLeafNodeId || 0,
        quantity: Number(overrides.batchQuantityByNode?.[feeder.id]) || producedQty || 1,
      });
    }
    if (!lines.length) return null;

    // Inventory owns sets and their stock: it matches the composition against
    // the defined sets, keeps the one produced set for this run and node, and
    // books its stock.
    return inventoryPorts.sets.recordProduced({
      runId,
      nodeId,
      nodeName: node.name || '',
      lines,
      producedQty,
    });
  }

  // One-time copy of legacy pipeline_runs.node_metrics_json into the table so
  // reports can query reconciliation data with plain SQL. INSERT OR IGNORE keeps
  // rows already written through the endpoint authoritative; idempotent per boot.
  async function backfillStageReconciliations() {
    const rows = await all(
      `SELECT id, node_metrics_json FROM pipeline_runs
       WHERE node_metrics_json IS NOT NULL AND node_metrics_json NOT IN ('', '{}')`,
    );
    for (const row of rows) {
      const nodeMetrics = parseJson(row.node_metrics_json, {});
      for (const [nodeId, metrics] of Object.entries(nodeMetrics)) {
        const cols = [];
        const vals = [];
        for (const [key, col] of Object.entries(STAGE_RECON_COLUMNS)) {
          if (metrics[key] !== undefined) {
            cols.push(col);
            vals.push(metrics[key]);
          }
        }
        if (!cols.length) continue;
        await run(
          `INSERT OR IGNORE INTO stage_reconciliations (run_id, node_id, ${cols.join(', ')}, updated_at)
           VALUES (?, ?, ${cols.map(() => '?').join(', ')}, datetime('now'))`,
          [row.id, nodeId, ...vals],
        );
      }
    }
  }

  // nodeMetrics for a pipeline_runs row: stage_reconciliations is the source of
  // truth; the legacy blob sits underneath so pre-migration and demo-seeded runs
  // still render.
  async function getMergedNodeMetrics(row) {
    const nodeMetrics = parseJson(row.node_metrics_json, {});
    const reconRows = await all(
      'SELECT * FROM stage_reconciliations WHERE run_id = ?',
      [row.id],
    );
    for (const recon of reconRows) {
      const merged = { ...(nodeMetrics[recon.node_id] || {}) };
      for (const [key, col] of Object.entries(STAGE_RECON_COLUMNS)) {
        if (recon[col] !== null && recon[col] !== undefined) {
          merged[key] = recon[col];
        }
      }
      nodeMetrics[recon.node_id] = merged;
    }
    return nodeMetrics;
  }

  // --- a run and the order line it was started for -------------------------
  //
  // The link (order_pipeline_assignments) is production's. What the linked line
  // IS belongs to orders, and is asked for at the kernel desk. A run can be linked
  // to several lines; like the joins these replace, the first link whose line
  // still exists is the one that answers.

  async function firstLinkedLine(runId, lookup) {
    const links = await all(
      'SELECT order_item_id FROM order_pipeline_assignments WHERE pipeline_run_id = ? ORDER BY rowid ASC',
      [runId],
    );
    for (const link of links) {
      const found = await lookup(link.order_item_id);
      if (found) return found;
    }
    return undefined;
  }

  /// The order line a run makes: `{ item_id, variation_leaf_node_id,
  /// variation_path_label, … }`, or undefined when the run is not order-linked.
  function orderLineForRun(runId) {
    return firstLinkedLine(runId, async (orderItemId) =>
      (await desk.ask('orders.lines.get', { orderItemId })).line);
  }

  /// The order a run belongs to: `{ order_item_id, order_no, client_name }`.
  function orderForRun(runId) {
    return firstLinkedLine(runId, async (orderItemId) =>
      (await desk.ask('orders.lines.summary', { orderItemId })).summary);
  }

  async function rowToRun(row) {
    if (!row) {
      return null;
    }

    const barcodeRows = await all(
      'SELECT node_id, barcode, source_kind, material_payload_json FROM run_barcode_inputs WHERE run_id = ? ORDER BY scanned_at DESC',
      [row.id],
    );

    const attachedBarcodeInputs = {};
    for (const barcodeRow of barcodeRows) {
      if (!attachedBarcodeInputs[barcodeRow.node_id]) {
        attachedBarcodeInputs[barcodeRow.node_id] = [];
      }
      // What kind of input this is (a material barcode, a vendor sheet, or a
      // bare quantity) and the code that addresses the row. A quantity row's
      // payload carries no barcode of its own, and a client could not tell a
      // sheet from a material without the kind.
      const inputPayload = parseJson(barcodeRow.material_payload_json, {});
      attachedBarcodeInputs[barcodeRow.node_id].push({
        ...inputPayload,
        barcode: inputPayload.barcode || barcodeRow.barcode,
        sourceKind: barcodeRow.source_kind || 'barcode',
      });
    }

    const orderAssignment = await orderForRun(row.id);

    const nodeMetrics = await getMergedNodeMetrics(row);

    return {
      id: row.id,
      templateId: row.template_id,
      templateVersion: row.template_version,
      name: row.name || '',
      status: row.status || 'planned',
      overrides: parseJson(row.overrides_json, {}),
      nodeStatuses: parseJson(row.node_status_json, {}),
      scrapRouting: row.scrap_routing || 'inventory',
      // What this run says it is making, when no order line says it for them.
      // 0 means unstated, which is a different thing from a base item.
      outputVariationLeafNodeId: Number(row.output_variation_leaf_node_id || 0) || 0,
      outputVariationPathLabel: row.output_variation_path_label || '',
      nodeMetrics,
      batches: parseJson(row.batches_json, []),
      attachedBarcodeInputs,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      orderNo: orderAssignment?.order_no || null,
      clientName: orderAssignment?.client_name || null,
      orderItemId: orderAssignment?.order_item_id || null,
    };
  }

  function rowToProductionRunDto(row) {
    if (!row) {
      return null;
    }
    return {
      id: Number(row.id || 0),
      runCode: row.run_code || '',
      status: row.status || '',
      completedAt: row.completed_at || null,
      itemId: Number(row.item_id || 0),
      itemName: row.item_name || '',
      variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
      variationPathLabel: row.variation_path_label || '',
      outputQuantity: Number(row.output_quantity || 0),
      uom: row.uom || 'pcs',
      location: row.location || '',
    };
  }

  async function listCompletedProductionRuns({ search = '', limit = 25 } = {}) {
    const normalizedSearch = String(search || '').trim().toLowerCase();
    const params = [];
    let searchSql = '';
    if (normalizedSearch) {
      searchSql = `
        AND (
          LOWER(pr.run_code) LIKE ?
          OR LOWER(i.display_name) LIKE ?
          OR LOWER(i.name) LIKE ?
          OR LOWER(pr.variation_path_label) LIKE ?
        )
      `;
      params.push(
        `%${normalizedSearch}%`,
        `%${normalizedSearch}%`,
        `%${normalizedSearch}%`,
        `%${normalizedSearch}%`,
      );
    }
    params.push(Math.min(Math.max(Number(limit || 25), 1), 100));
    const rows = await all(
      `
      SELECT pr.*, COALESCE(i.display_name, i.name, '') AS item_name
      FROM production_runs pr
      INNER JOIN items i ON i.id = pr.item_id
      WHERE pr.status = 'completed'
        AND COALESCE(i.is_archived, 0) = 0
        ${searchSql}
      ORDER BY datetime(pr.completed_at) DESC, pr.id DESC
      LIMIT ?
      `,
      params,
    );
    return rows.map(rowToProductionRunDto);
  }

  async function getProductionRunRowById(id) {
    return get(
      `
      SELECT pr.*, COALESCE(i.display_name, i.name, '') AS item_name
      FROM production_runs pr
      INNER JOIN items i ON i.id = pr.item_id
      WHERE pr.id = ?
      `,
      [Number(id || 0)],
    );
  }

  async function createRunFromTemplate(
    templateId,
    name,
    orderNo,
    orderItemId,
    scrapRouting = 'inventory',
    actor = null,
    // What this run is making, when it is not being made for an order line.
    // An operator starting a run to build stock usually knows; before this there
    // was nowhere to write it down, so completing the run had to either guess a
    // variation or decline to mint anything.
    { outputVariationLeafNodeId = 0, outputVariationPathLabel = '' } = {},
  ) {
    const templateRow = await templateRowById(templateId);
    if (!templateRow) {
      return null;
    }
    const template = rowToTemplate(templateRow);
    const now = new Date().toISOString();
    const runId = `run-${Date.now()}`;
    const nodeStatuses = Object.fromEntries(
      template.nodes.map((node) => [node.id, 'pending']),
    );

    await run(
      `
      INSERT INTO pipeline_runs (
        id, template_id, template_version, name, status, overrides_json,
        node_status_json, scrap_routing, node_metrics_json, started_at, completed_at, created_at, created_by,
        output_variation_leaf_node_id, output_variation_path_label
      ) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, '{}', NULL, NULL, ?, ?, ?, ?)
      `,
      [
        runId,
        template.id,
        template.version,
        name || `Run ${new Date(now).toLocaleDateString('en-IN')} - ${Date.now()}`,
        JSON.stringify({
          actualDurationHoursByNode: {},
          batchQuantityByNode: {},
          machineOverrideByNode: {},
        }),
        JSON.stringify(nodeStatuses),
        scrapRouting,
        now,
        actor?.name || null,
        Number(outputVariationLeafNodeId || 0) || 0,
        String(outputVariationPathLabel || ''),
      ],
    );

    if (orderItemId) {
      await run(
        'INSERT INTO order_pipeline_assignments (order_item_id, pipeline_run_id) VALUES (?, ?)',
        [orderItemId, runId]
      );
    } else if (orderNo) {
      for (const lineId of (await desk.ask('orders.lines.idsForOrderNo', { orderNo })).ids) {
        await run(
          'INSERT INTO order_pipeline_assignments (order_item_id, pipeline_run_id) VALUES (?, ?)',
          [lineId, runId]
        );
      }
    }

    const runRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [runId]);
    return rowToRun(runRow);
  }

  async function ensurePipelineRunRecord({
    id,
    templateId,
    name,
    status,
    createdAt,
    startedAt = null,
    completedAt = null,
    nodeStatuses,
    overrides,
    barcodeAssignments = [],
  }) {
    const templateRow = await templateRowById(templateId);
    if (!templateRow) {
      return null;
    }

    const template = rowToTemplate(templateRow);
    const existing = await get('SELECT * FROM pipeline_runs WHERE id = ?', [id]);
    const resolvedNodeStatuses =
      nodeStatuses ||
      Object.fromEntries(template.nodes.map((node) => [node.id, 'pending']));
    const resolvedOverrides =
      overrides || {
        actualDurationHoursByNode: {},
        batchQuantityByNode: {},
        machineOverrideByNode: {},
      };

    if (!existing) {
      await run(
        `
        INSERT INTO pipeline_runs (
          id, template_id, template_version, name, status, overrides_json,
          node_status_json, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          templateId,
          template.version,
          name,
          status,
          JSON.stringify(resolvedOverrides),
          JSON.stringify(resolvedNodeStatuses),
          startedAt,
          completedAt,
          createdAt,
        ],
      );
    } else {
      await run(
        `
        UPDATE pipeline_runs
        SET template_id = ?, template_version = ?, name = ?, status = ?, overrides_json = ?,
            node_status_json = ?, started_at = ?, completed_at = ?, created_at = ?
        WHERE id = ?
        `,
        [
          templateId,
          template.version,
          name,
          status,
          JSON.stringify(resolvedOverrides),
          JSON.stringify(resolvedNodeStatuses),
          startedAt,
          completedAt,
          createdAt,
          id,
        ],
      );
    }

    await run('DELETE FROM run_barcode_inputs WHERE run_id = ?', [id]);
    for (const assignment of barcodeAssignments) {
      const materialRow = assignment.barcode
        ? await getMaterialRowByBarcode(assignment.barcode)
        : null;

      if (!materialRow) {
        // Consumption by quantity rather than by piece.
        //
        // Not every input is a barcoded thing you can scan. Stock that arrived
        // as "300 kg of this variation" has no piece to point at, and until now
        // an assignment that could not be named by barcode was dropped here —
        // silently, which is how a run came to consume material that no record
        // admits to.
        //
        // Recorded in the grain it was actually consumed in: item, variation and
        // an amount, with a synthetic barcode that could never collide with a
        // real one so the row stays uniquely addressable.
        const quantityItemId = Number(assignment.itemId ?? assignment.item_id ?? 0);
        const quantity = Number(assignment.consumedQty ?? assignment.quantity ?? 0);
        if (!(quantityItemId > 0) || !(quantity > 0)) {
          continue;
        }
        const leafNodeId =
          Number(
            assignment.variationLeafNodeId ?? assignment.variation_leaf_node_id ?? 0,
          ) || null;
        await run(
          `
          INSERT INTO run_barcode_inputs (
            id, run_id, node_id, barcode, material_id, material_payload_json,
            scanned_at, challan_item_id, item_id, variation_leaf_node_id,
            consumed_qty, source_kind
          ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 'quantity')
          `,
          [
            assignment.id,
            id,
            assignment.nodeId,
            `#qty-${assignment.id}`,
            JSON.stringify({
              itemId: quantityItemId,
              variationLeafNodeId: leafNodeId,
              quantity,
            }),
            assignment.scannedAt || createdAt,
            Number(assignment.challanItemId ?? assignment.challan_item_id ?? 0) || null,
            quantityItemId,
            leafNodeId,
            quantity,
          ],
        );
        continue;
      }
      // What was consumed, and where it came from.
      //
      // `challan_item_id` is the bridge: it names the reception line this stock
      // arrived on, which is what lets an order say what material went into it.
      // It comes off the material row, so it is only there for stock that was
      // actually received rather than created directly in inventory — and a null
      // means exactly that, rather than meaning nothing was consumed.
      //
      // item + variation are recorded alongside so a consumption reads in the
      // same grain challans move stock in, and a quantity consumption (below)
      // can be counted next to a barcoded one.
      const consumedQty = Number(
        assignment.consumedQty ?? assignment.quantity ?? materialRow.on_hand_qty ?? 0,
      );
      await run(
        `
        INSERT INTO run_barcode_inputs (
          id, run_id, node_id, barcode, material_id, material_payload_json,
          scanned_at, challan_item_id, item_id, variation_leaf_node_id,
          consumed_qty, source_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          assignment.id,
          id,
          assignment.nodeId,
          materialRow.barcode,
          String(materialRow.id || ''),
          JSON.stringify({
            barcode: materialRow.barcode,
            materialName: materialRow.name,
            materialType: materialRow.type,
            scanCount: materialRow.scan_count || 0,
          }),
          assignment.scannedAt || createdAt,
          materialRow.source_challan_item_id ?? null,
          materialRow.linked_item_id ?? null,
          materialRow.linked_variation_leaf_node_id ?? null,
          Number.isFinite(consumedQty) && consumedQty > 0 ? consumedQty : null,
          'barcode',
        ],
      );
    }

    const runRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [id]);
    return rowToRun(runRow);
  }

  let runInputSequence = Math.floor(Math.random() * 1000);

  /// One material put on a run node: the input row, the custody event, and,
  /// when a quantity is given, the stock taken off the material. Used for a
  /// scanned or dragged barcode and for each barcode of an approved quantity
  /// split, so both leave exactly the same records.
  async function assignMaterialToRunNode({ runId, payload, actorName }) {
    const materialRow = await inventoryPorts.scans.increment(payload.barcode);
    if (!materialRow) {
      const error = new Error(`No material found for barcode ${payload.barcode}.`);
      error.statusCode = 404;
      throw error;
    }
    const material = rowToMaterialDto(materialRow);
    // A counter, not a random number: a quantity split writes several of these in
    // the same millisecond and two must never share an id.
    runInputSequence += 1;
    const barcodeInputId = `barcode-${Date.now()}-${runInputSequence}`;
    // The bridge. `source_challan_item_id` is on the material because issuing a
    // reception minted it there, so a consumption can name the line the stock
    // arrived on — which is what lets an order say what went into it. Null for
    // stock created directly in inventory, and that null means exactly that.
    const consumedQty =
      payload.quantity !== undefined && payload.quantity !== null
        ? Number(payload.quantity)
        : null;
    await run(
      `
      INSERT INTO run_barcode_inputs (
        id, run_id, node_id, barcode, material_id, material_payload_json,
        scanned_at, challan_item_id, item_id, variation_leaf_node_id,
        consumed_qty, source_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'barcode')
      `,
      [
        barcodeInputId,
        runId,
        payload.nodeId,
        material.barcode,
        String(material.id || ''),
        JSON.stringify({
          barcode: material.barcode,
          materialName: material.name,
          materialType: material.type,
          scanCount: material.scanCount,
          quantity: consumedQty,
          unit: material.unit,
        }),
        new Date().toISOString(),
        materialRow.source_challan_item_id ?? null,
        materialRow.linked_item_id ?? null,
        materialRow.linked_variation_leaf_node_id ?? null,
        Number.isFinite(consumedQty) && consumedQty > 0 ? consumedQty : null,
      ],
    );

    // Custody moves from the shelf to the floor. The run is the child rather
    // than the subject: what happened is that *this material* was issued, and
    // the ledger reads as the material's story when you scan the material.
    await recordLedgerEvent({
      subjectBarcode: barcodes.encode('MAT', material.barcode),
      eventType: 'ISSUED_TO_PIPELINE',
      actorName: actorName,
      children: [barcodes.encode('RUN', runId)],
      metrics: {
        qty: consumedQty,
        unit: material.unit || '',
        nodeId: payload.nodeId,
      },
      notes: material.name || '',
    });

    if (payload.quantity !== undefined && payload.quantity !== null) {
      const qty = Number(payload.quantity);
      if (qty > 0) {
        await inventoryPorts.movements.apply({
          barcode: material.barcode,
          movementType: 'consume',
          qty: qty,
          actor: 'Floor Engineer',
          referenceType: 'pipeline_run',
          referenceId: runId,
          reasonCode: 'PRODUCTION_ASSIGN',
        });
      }
    }
  }

  /// Sets one node's status on a run, with the duration, batch quantity and
  /// machine recorded beside it, and does what follows from it:
  ///   - a node reaching an Assembly step raises its job in the freelancer pool,
  ///     once per run and node however often the status is set again;
  ///   - when every node is done or skipped the run is completed, booked once as
  ///     a production run under a code made from its whole id, and, when the
  ///     output item and variation are known, minted as a lot in inventory with
  ///     an OUTPUT_MINTED custody event.
  /// Answers `{ run }`, or `{ refusal: { status, body } }` for an unknown run or
  /// a request with no node or status. Moved whole from the route handler.
  async function setNodeStatus({ runId, payload = {}, actor = null }) {
    const runRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [runId]);
    if (!runRow) {
      return { refusal: { status: 404, body: { success: false, run: null, error: 'Run not found.' } } };
    }

    const nodeId = payload.nodeId;
    if (!nodeId || !payload.status) {
      return { refusal: { status: 400, body: {
        success: false,
        run: null,
        error: 'nodeId and status are required.',
      } } };
    }

    const nodeStatuses = parseJson(runRow.node_status_json, {});
    nodeStatuses[nodeId] = payload.status;

    const overrides = parseJson(runRow.overrides_json, {
      actualDurationHoursByNode: {},
      batchQuantityByNode: {},
      machineOverrideByNode: {},
    });

    if (payload.actualDurationHours !== undefined && payload.actualDurationHours !== null) {
      overrides.actualDurationHoursByNode[nodeId] = Number(payload.actualDurationHours);
    }
    if (payload.batchQuantity !== undefined && payload.batchQuantity !== null) {
      overrides.batchQuantityByNode[nodeId] = Number(payload.batchQuantity);
    }
    if (payload.machineOverride) {
      overrides.machineOverrideByNode[nodeId] = payload.machineOverride;
    }

    await run(
      'UPDATE pipeline_runs SET node_status_json = ?, overrides_json = ? WHERE id = ?',
      [JSON.stringify(nodeStatuses), JSON.stringify(overrides), runId],
    );

    // Push to freelancer pool if Assembly node is reached
    const templateRowNode = await templateRowById(runRow.template_id);
    if (templateRowNode && (payload.status === 'ready' || payload.status === 'active' || payload.status === 'queued')) {
      const tpl = rowToTemplate(templateRowNode);
      const targetNode = tpl.nodes.find(n => n.id === nodeId);
      if (targetNode && targetNode.processType === 'Assembly') {
        const qty = overrides.batchQuantityByNode[nodeId] || 1;
        
        // An assembly step is a merge point with no bound item of its own —
        // parts arrive on the flows from the steps feeding it, and the work is
        // manual. So the job is raised against what the run is actually
        // building: the order line it was started for. Only if the run is not
        // order-linked do we fall back to the upstream feeders' output items,
        // and finally to the node's own binding for older templates that still
        // carry one.
        let itemId = 0;
        const orderLink = await orderLineForRun(runRow.id);
        if (orderLink?.item_id) itemId = orderLink.item_id;

        if (!itemId) {
          const feederIds = new Set(
            (tpl.flows || [])
              .filter((f) => f.toNodeId === nodeId)
              .map((f) => f.fromNodeId),
          );
          for (const feeder of (tpl.nodes || [])) {
            if (!feederIds.has(feeder.id)) continue;
            if (feeder.outputItem && feeder.outputItem.itemId) {
              itemId = feeder.outputItem.itemId;
              break;
            }
          }
        }

        if (!itemId) {
          itemId = (targetNode.outputItem && targetNode.outputItem.itemId) || 0;
        }
        if (!itemId) {
          const outName = targetNode.outputs && targetNode.outputs[0];
          if (outName) {
             const matched = await itemsPorts.lookupByName(outName);
             if (matched) itemId = matched.id;
          }
        }
        // A job has to point at a real item — freelancer_jobs.item_id is a
        // foreign key and the clients read it as non-null. Without one there
        // is nothing to hand a worker, so skip rather than fail the status
        // update the shop floor is waiting on.
        if (!itemId) {
          console.warn(
            `[assembly] run ${runRow.id} node ${nodeId}: not order-linked and no`
            + ' feeder step carries an output item; no job raised.',
          );
        } else {
          // Keyed on (run, node) inside: a node's status can be re-set any number
          // of times and must not fan out into duplicate jobs.
          await jobsService.syncAssemblyJob({ runId: runRow.id, nodeId, itemId, qty });
        }
      }
    }

    // Check if the overall pipeline run is completed
    const templateRow = await templateRowById(runRow.template_id);
    if (templateRow) {
      const template = rowToTemplate(templateRow);
      const allDone = template.nodes.every((node) => {
        const s = nodeStatuses[node.id];
        return s === 'done' || s === 'skipped';
      });

      if (allDone && runRow.status !== 'completed') {
        const now = new Date().toISOString();
        await run(
          "UPDATE pipeline_runs SET status = 'completed', completed_at = ? WHERE id = ?",
          [now, runId],
        );

        // Find item ID to link to the flat production run
        let itemId = null;
        let variationLeafNodeId = 0;
        let variationPathLabel = '';

        const lastNode = template.nodes.find((n) => !n.isIntermediate) || template.nodes[template.nodes.length - 1];
        const finalOutput = lastNode && lastNode.outputs && lastNode.outputs[0];
        if (finalOutput) {
          const matchedItem = await itemsPorts.lookupByName(finalOutput);
          if (matchedItem) {
            itemId = matchedItem.id;
            // Which variation was produced comes from the order line this run
            // is assigned to. That is the only place that actually knows.
            //
            // What was here before asked for
            //   item_variation_nodes WHERE kind = 'leaf' LIMIT 1
            // and `kind` has only ever held 'property' or 'value' — there is no
            // 'leaf' kind in this table. So it never matched, the leaf id stayed
            // 0, and resolveOrderVariationSelection then threw "Client, item and
            // variation values are required" for every output item that has
            // variations, taking the whole completion request down with a 500.
            // No run could finish and no output was ever minted.
            //
            // It was also a guess even when it did match: LIMIT 1 with no
            // ordering picks an arbitrary variation, which would have labelled
            // the finished goods with whichever one happened to come first.
            const assignedLine = await orderLineForRun(runId);
            // Only when the order line is for the same item the template says it
            // outputs. Otherwise this would stamp one item's variation onto
            // another item's goods.
            if (
              assignedLine
              && Number(assignedLine.item_id) === Number(itemId)
              && Number(assignedLine.variation_leaf_node_id) > 0
            ) {
              variationLeafNodeId = Number(assignedLine.variation_leaf_node_id);
              variationPathLabel = assignedLine.variation_path_label || '';
            } else if (Number(runRow.output_variation_leaf_node_id || 0) > 0) {
              // No order line, but the operator said what they were making when
              // they started the run. That is a statement of intent from the
              // person at the machine, which is weaker than an order line and
              // far stronger than picking a variation at random.
              //
              // Order matters: the order line wins when both exist, because it
              // is what was actually promised to a customer.
              variationLeafNodeId = Number(runRow.output_variation_leaf_node_id);
              variationPathLabel = runRow.output_variation_path_label || '';
            }
            // Neither? Then nothing here knows, and the snapshot below will
            // decline rather than invent one.
          }
        }

        if (itemId) {
          const batchQuantity = (lastNode && overrides.batchQuantityByNode[lastNode.id]) || 1;
          // Derived from the WHOLE run id, not its first eight characters.
          //
          // Truncating collided catastrophically: on a real database 68 of 72
          // runs had ids beginning `run-ord-`, so they all produced the same
          // run_code. `production_runs.run_code` is UNIQUE, so the first run to
          // complete took it and the `if (!exists)` below then silently swallowed
          // the other 67 — real goods finished with no production_runs row, no
          // lot, and no inventory movement.
          //
          // It also made the MFG barcode a lie: one code naming 68 different
          // runs' output, in a ledger that cannot be corrected afterwards. A
          // derived code is only safe when what it derives from is unique, and
          // eight characters of a prefixed id is not.
          const upperRunId = String(runId).toUpperCase();
          const runCode = upperRunId.startsWith('RUN-') ? upperRunId : `RUN-${upperRunId}`;

          // Now genuinely "has this run already been booked as output?", which
          // is the idempotency this check was always meant to express.
          const exists = await get('SELECT id FROM production_runs WHERE run_code = ?', [runCode]);
          if (!exists) {
            await run(
              `
              INSERT INTO production_runs (
                run_code, status, completed_at, item_id, variation_leaf_node_id,
                variation_path_label, output_quantity, uom, location,
                source_metadata_json, created_at, updated_at
              ) VALUES (?, 'completed', ?, ?, ?, ?, ?, 'pcs', 'Production Output', ?, ?, ?)
              `,
              [
                runCode,
                now,
                itemId,
                variationLeafNodeId,
                variationPathLabel,
                batchQuantity,
                JSON.stringify({
                  pipelineRunId: runId,
                  pipelineTemplateId: runRow.template_id,
                  pipelineName: runRow.name,
                }),
                now,
                now,
              ]
            );
            
            // Generate a fresh barcode and add inventory for the completed pipeline
            const freshBarcode = `LOT-${runCode}-${Math.floor(Math.random() * 1000)}`;
                        
            // We use ensureMaterialForItemSelection, but we override barcode to force a fresh lot
            // First get the template/snapshot
            // resolveOrderVariationSelection returns the base item cleanly when
            // an item has no variation properties, and throws when it has them
            // and none was chosen. That throw is correct — it is what stops a
            // half-specified order line — but it must not take a completed
            // production run down with it. The stage really did finish.
            //
            // So: complete the run either way, and mint only when the output is
            // actually identifiable. Minting against a guessed variation would
            // put a wrong fact into inventory and, worse, name it permanently in
            // an append-only ledger. Not minting is recoverable; a mislabelled
            // lot is not.
            let snapshot = null;
            try {
              snapshot = await getItemSelectionSnapshot(itemId, variationLeafNodeId);
            } catch (snapshotError) {
              console.warn(
                `[run ${runId}] completed but no output was minted: `
                + `cannot tell which variation of item ${itemId} was produced `
                + `(${snapshotError.message}). Assign the run to an order line `
                + `so the variation is known.`,
              );
            }
            if (snapshot) {
              const uom = snapshot.item.unit || 'pcs';
              const uomId = snapshot.item.unit_id || null;
              
              await inventoryPorts.receipts.mintLot({
                barcode: freshBarcode,
                // `particulars` is what the snapshot actually returns; there is
                // no `fullName` on it, so this read undefined every time and
                // every finished lot in the system was literally called
                // "Finished Good".
                name: snapshot.particulars || 'Finished Good',
                type: 'material',
                groupId: snapshot.item.group_id,
                itemId,
                leafNodeId: variationLeafNodeId,
                unit: uom,
                unitId: uomId,
                createdAt: now,
              });
              
              await inventoryPorts.movements.applyCore({
                barcode: freshBarcode,
                movementType: 'receive',
                qty: Number(batchQuantity),
                primaryQty: Number(batchQuantity),
                uom: uom,
                toLocationId: 'MAIN',
                reasonCode: 'production_output',
                referenceType: 'pipeline_run',
                referenceId: runId,
                actor: actor?.id || null,
                lotCode: freshBarcode,
              }, { useTransaction: false });

              // A new thing came into being, and this is the one event that
              // makes backward traceability possible. Scanning a finished piece
              // has to reach the raw material it was cut from in one hop —
              // that is the question a warranty claim or a QC recall opens
              // with, and every other event in the trail is downstream of being
              // able to answer it.
              //
              // The MFG code is the subject because that is what gets printed
              // on the piece and scanned off it later. This is the mirror of
              // ISSUED_TO_PIPELINE, where the material is the subject and the
              // run is a child: there custody left the shelf, here something
              // new exists. The lot barcode is the child rather than the
              // subject so that scanning either one surfaces this event —
              // loadCustody matches on subject OR parents OR children.
              const consumedInputs = await all(
                'SELECT DISTINCT barcode FROM run_barcode_inputs WHERE run_id = ?',
                [runId],
              );
              // The order is read from order_pipeline_assignments, the way
              // rowToRun does it. `pipeline_runs` has no order_item_id column,
              // despite one place in this file reading it.
              const outputOrderLink = await orderForRun(runId);
              await recordLedgerEvent({
                subjectBarcode: barcodes.encode('MFG', runCode),
                eventType: 'OUTPUT_MINTED',
                actorName: actor?.name || 'Floor',
                parents: [
                  barcodes.encode('RUN', runId),
                  ...consumedInputs.map((row) => barcodes.encode('MAT', row.barcode)),
                ].filter(Boolean),
                children: [barcodes.encode('MAT', freshBarcode)].filter(Boolean),
                orderBarcode: outputOrderLink?.order_no
                  ? barcodes.encode('ORD', outputOrderLink.order_no)
                  : null,
                metrics: {
                  qty: Number(batchQuantity),
                  unit: uom || 'pcs',
                  itemId,
                  variationLeafNodeId,
                  pipelineRunId: runId,
                  pipelineTemplateId: runRow.template_id,
                  lotBarcode: freshBarcode,
                },
                notes: snapshot.particulars || 'Finished Good',
              });
            }
          }
        }
      }
    }

    const updatedRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [
      runId,
    ]);
    return { run: await rowToRun(updatedRow) };
  }

  return {
    upsertStageReconciliation,
    ensureTemporarySetFromAssembly,
    backfillStageReconciliations,
    getMergedNodeMetrics,
    rowToRun,
    rowToProductionRunDto,
    listCompletedProductionRuns,
    getProductionRunRowById,
    createRunFromTemplate,
    ensurePipelineRunRecord,
    assignMaterialToRunNode,
    STAGE_RECON_COLUMNS,
    setNodeStatus,
    orderForRun,
    orderLineForRun,
  };
}

module.exports = { createProductionService };
