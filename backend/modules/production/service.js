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
  getMaterialRowByBarcode,
  inventoryPorts,
  jobsService,
  parseJson,
  recordLedgerEvent,
  rowToMaterialDto,
  rowToTemplate,
  run,
}) {
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
    const templateRow = await get('SELECT * FROM pipeline_templates WHERE id = ?', [runRow.template_id]);
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

    // Match the composition against the defined sets: same (item, variation) on
    // both sides, ignoring quantity — a Starter Pack is a Starter Pack whether
    // one or a thousand came off the line.
    const signature = (rows) => rows
      .map((l) => `${l.itemId}:${l.leafId}`)
      .sort()
      .join('|');
    const ours = signature(lines);
    let matched = null;
    const defined = await all(
      'SELECT id, name FROM inventory_sets WHERE COALESCE(is_temporary, 0) = 0',
    );
    for (const candidate of defined) {
      const candidateLines = await all(
        'SELECT item_id AS itemId, variation_leaf_node_id AS leafId FROM inventory_set_lines WHERE set_id = ?',
        [candidate.id],
      );
      if (candidateLines.length && signature(candidateLines) === ours) {
        matched = candidate;
        break;
      }
    }

    const now = new Date().toISOString();
    const label = matched ? matched.name : (node.name || 'Assembly');
    const name = `Temporary · ${label} · ${runId}`;

    const existing = await get(
      'SELECT id FROM inventory_sets WHERE origin_run_id = ? AND origin_node_id = ?',
      [runId, nodeId],
    );
    let setId;
    if (existing) {
      setId = existing.id;
      // Bumped, but never conditional: a run must not fail because somebody has
      // the produced set open in the editor. The bump is what makes their save
      // bounce off instead of overwriting what the run just recorded — production
      // wins, and the person is told rather than silently losing.
      await run(
        `UPDATE inventory_sets
            SET name = ?, source_set_id = ?, produced_at = ?, updated_at = ?,
                version = version + 1
          WHERE id = ?`,
        [name, matched?.id ?? null, now, now, setId],
      );
      await run('DELETE FROM inventory_set_lines WHERE set_id = ?', [setId]);
    } else {
      // No group link, deliberately: a produced set is run output, not the
      // definition it matched, so it does not inherit source_set_id's group and
      // reads as ungrouped everywhere.
      const inserted = await run(
        `INSERT INTO inventory_sets
           (name, created_at, updated_at, origin_run_id, origin_node_id,
            source_set_id, produced_at, is_temporary)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [name, now, now, runId, nodeId, matched?.id ?? null, now],
      );
      setId = inserted.lastID;
    }

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      await run(
        `INSERT INTO inventory_set_lines
           (set_id, item_id, variation_leaf_node_id, quantity, position)
         VALUES (?, ?, ?, ?, ?)`,
        // variation_leaf_node_id is a foreign key into item_variation_nodes, so a
        // base item with no variation stores NULL — 0 is not a node.
        [setId, line.itemId, line.leafId || null, line.quantity, i],
      );
    }

    await stockTemporarySet(setId, name, runId, nodeId, producedQty);
    return setId;
  }

  /**
   * The set holds stock like anything else in inventory, so it gets a materials
   * row and a ledger. The first entry is the one that just happened: it came IN
   * off the production run. It leaves later, when the job is handed to a worker.
   */
  async function stockTemporarySet(setId, name, runId, nodeId, producedQty) {
    const barcode = `SET-${runId}-${nodeId}`;
    const now = new Date().toISOString();
    const existing = await getMaterialRowByBarcode(barcode);
    if (!existing) {
      await run(
        `INSERT INTO materials
           (barcode, name, type, kind, unit, created_at, updated_at, linked_set_id,
            material_class, workflow_status, location, on_hand_qty)
         VALUES (?, ?, 'set', 'standalone', 'Set', ?, ?, ?, 'assembled_set', 'active', 'MAIN', 0)`,
        [barcode, name, now, now, setId],
      );
    } else {
      await run(
        'UPDATE materials SET name = ?, updated_at = ?, linked_set_id = ? WHERE barcode = ?',
        [name, now, setId, barcode],
      );
    }

    // Book the production receipt as the difference from what the ledger already
    // holds, so a corrected reconciliation adjusts rather than double-counts.
    const received = await get(
      `SELECT COALESCE(SUM(qty), 0) AS qty FROM inventory_movements
        WHERE material_barcode = ? AND movement_type = 'receive' AND reason_code = 'production'`,
      [barcode],
    );
    const delta = Number(producedQty || 0) - Number(received?.qty || 0);
    if (delta > 0) {
      await inventoryPorts.movements.applyCore({
        barcode,
        // Movement types are receive/issue/transfer/adjust/… — 'in' and 'out'
        // silently normalise to 'adjust' and the ledger loses its direction.
        movementType: 'receive',
        qty: delta,
        reasonCode: 'production',
        referenceType: 'pipeline_run',
        referenceId: runId,
        actor: 'assembly',
      }, { useTransaction: false });
    }
    return barcode;
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

    const orderAssignment = await get(`
      SELECT h.order_no, c.name as client_name, opa.order_item_id
      FROM order_pipeline_assignments opa
      JOIN order_items i ON opa.order_item_id = i.id
      JOIN order_headers h ON i.order_no = h.order_no
      LEFT JOIN clients c ON h.client_id = c.id
      WHERE opa.pipeline_run_id = ?
      LIMIT 1
    `, [row.id]);

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
    const templateRow = await get(
      'SELECT * FROM pipeline_templates WHERE id = ?',
      [templateId],
    );
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
      const orderItems = await all(
        'SELECT id FROM order_items WHERE order_no = ?',
        [orderNo]
      );
      for (const item of orderItems) {
        await run(
          'INSERT INTO order_pipeline_assignments (order_item_id, pipeline_run_id) VALUES (?, ?)',
          [item.id, runId]
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
    const templateRow = await get('SELECT * FROM pipeline_templates WHERE id = ?', [
      templateId,
    ]);
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

  return {
    upsertStageReconciliation,
    ensureTemporarySetFromAssembly,
    stockTemporarySet,
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
  };
}

module.exports = { createProductionService };
