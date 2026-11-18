'use strict';

const barcodes = require('../../kernel/barcodes');

// ---------------------------------------------------------------------------
// Orders over HTTP: what has happened to an order. Read models, and returns.
//
//   GET  /api/orders/fulfilment                  every open line: ordered, made,
//                                                dispatched, and what is left
//   GET  /api/orders/:orderNo/pipeline-runs      the runs started for the order
//   GET  /api/orders/:orderNo/production-report  stage by stage, with machines
//                                                and dies
//   GET  /api/orders/:orderNo/returns            what came back
//   POST /api/orders/:orderNo/returns            record a return
//   GET  /api/orders/:orderNo/trace              backward lineage: runs, sheets,
//                                                pieces, challans, returns
//
// Each is one read model of an order's history. The order's lines are read
// here; its runs, their inputs and stage numbers are asked of production
// through productionPorts.runs. Challan tables (delivery challans, sheet tags)
// and machines and dies are still read here directly. The production helpers
// they shape rows with come in by name.
//
// NOT here, and still in server.js until their modules move:
//   GET /api/orders/:orderId/delivery-challans   (challans)
//   GET /api/orders/:orderNo/reconciliation      (challans and production)
// ---------------------------------------------------------------------------

module.exports = function registerOrderReportRoutes(ctx) {
  const {
    app,
    get,
    all,
    run,
    requirePermission,
    parseJson,
    getMergedNodeMetrics,
    rowToRun,
    machineRowToDto,
    dieRowToDto,
    actorFromRequest,
    recordLedgerEvent,
    desk,
  } = ctx;

  /// An order's runs, newest first, one row per run-and-line link, each with
  /// the `order_item_id` it is for. The lines are this module's; the runs are
  /// asked of production.
  async function runsForOrderNo(orderNo) {
    const lines = await all('SELECT id FROM order_items WHERE order_no = ?', [orderNo]);
    return (await desk.ask('production.runs.forOrderItems', { orderItemIds: lines.map((line) => line.id) })).runs;
  }

  // Fulfilment rollup for the whole order book, in one request. Everything else
  // production-side is keyed :orderNo one at a time, which makes a per-row
  // fulfilment bar N HTTP calls.
  //
  // "Produced" is the good output of a run's TERMINAL stage — the node with the
  // highest stageIndex in its template. Nothing marks a stage as terminal, so
  // ordering is the only signal available; summing stages instead would count
  // the same material once per stage.
  //
  // producedUnit is reported separately and NOT converted into the order's unit.
  // Floor reconciliation settles in kg while order lines are usually pieces, and
  // no conversion exists between them — inventing one would misreport fulfilment,
  // which is worse than showing two units.
  app.get('/api/orders/fulfilment', requirePermission('orders.read'), async (req, res) => {
    try {
      const rows = await all(
        'SELECT o.id, o.order_no, o.quantity, o.unit_symbol FROM order_items o',
      );

      // One row per (order line, challan). A challan can carry several lines for
      // the same order item — different notes, leaves or sheet splits — with no
      // unique constraint stopping it, so this groups rather than trusting that
      // it never happens.
      //
      // type = 'delivery' AND status = 'issued' is deliberately narrower than the
      // cumulative this replaces: that one counted reception and internal
      // challans whose lines carry an order_item_id as though they were
      // deliveries, and counted unissued drafts as goods that had left the
      // building. Issuing is the event that moves stock.
      const deliveryRows = await all(`
        SELECT
          dci.order_item_id AS order_item_id,
          dc.id             AS challan_id,
          dc.challan_no     AS challan_no,
          dc.date           AS challan_date,
          dc.status         AS challan_status,
          dc.customer_name  AS client_name,
          SUM(dci.quantity_pcs) AS quantity_pcs,
          SUM(dci.weight)       AS weight
        FROM delivery_challan_items dci
        JOIN delivery_challans dc ON dc.id = dci.challan_id
        WHERE dci.order_item_id IS NOT NULL
          AND dci.order_item_id > 0
          AND dc.type = 'delivery'
          AND dc.status = 'issued'
        GROUP BY dci.order_item_id, dc.id
        ORDER BY dci.order_item_id ASC, dc.date ASC, dc.id ASC
      `);
      const deliveriesByOrderItem = new Map();
      for (const row of deliveryRows) {
        const list = deliveriesByOrderItem.get(row.order_item_id) || [];
        list.push(row);
        deliveriesByOrderItem.set(row.order_item_id, list);
      }

      // One template read per template, not per run.
      const templateCache = new Map();
      const terminalNodeFor = async (templateId) => {
        if (templateCache.has(templateId)) return templateCache.get(templateId);
        const template = await get(
          'SELECT id, name, nodes_json FROM pipeline_templates WHERE id = ?',
          [templateId],
        );
        const nodes = template ? parseJson(template.nodes_json, []) : [];
        const terminal = nodes
          .slice()
          .sort((a, b) => Number(b.stageIndex || 0) - Number(a.stageIndex || 0))[0];
        const entry = { name: template?.name || '', terminal: terminal || null };
        templateCache.set(templateId, entry);
        return entry;
      };

      const { runs: assignments } = await desk.ask('production.runs.allWithOrderItem');
      const runsByOrderItem = new Map();
      for (const run of assignments) {
        const list = runsByOrderItem.get(run.order_item_id) || [];
        list.push(run);
        runsByOrderItem.set(run.order_item_id, list);
      }

      const fulfilment = [];
      for (const row of rows) {
        const runs = runsByOrderItem.get(row.id) || [];
        let producedQty = 0;
        let scrapQty = 0;
        let producedUnit = '';
        let templateName = '';
        let startedAt = null;
        let completedAt = null;
        let runStatus = runs.length === 0 ? 'none' : 'notStarted';

        for (const run of runs) {
          const { name, terminal } = await terminalNodeFor(run.template_id);
          if (name && !templateName) templateName = name;
          if (run.started_at && (!startedAt || run.started_at < startedAt)) {
            startedAt = run.started_at;
          }
          if (run.completed_at && (!completedAt || run.completed_at > completedAt)) {
            completedAt = run.completed_at;
          }
          if (run.status === 'completed') {
            if (runStatus !== 'inProgress') runStatus = 'completed';
          } else if (run.started_at) {
            runStatus = 'inProgress';
          }
          if (!terminal) continue;
          const metrics = await getMergedNodeMetrics(run);
          const terminalMetrics = metrics[terminal.id] || {};
          // goodYield is what the floor signed off as usable; output is the raw
          // reading. Prefer the former, fall back to the latter. getMergedNodeMetrics
          // maps columns to camelCase, so goodYield is the live key; good_yield can
          // only arrive from a legacy node_metrics_json blob.
          const good = Number(
            terminalMetrics.goodYield ?? terminalMetrics.good_yield ?? 0,
          );
          const output = Number(terminalMetrics.output ?? 0);
          producedQty += good > 0 ? good : output;
          scrapQty += Number(terminalMetrics.scrap ?? 0);
          if (!producedUnit) {
            // outputItem.unitSymbol is the only one of these the app actually
            // writes. Left empty when the stage never declared a unit — the
            // client then refuses to draw produced against ordered, which is the
            // honest outcome. Never guess a unit here.
            producedUnit = String(
              terminal.outputUnit
                || terminal.unit
                || terminal.outputItem?.unitSymbol
                || '',
            ).trim();
          }
        }

        // Derived from the same rows the list is built from, so the headline
        // total and the individual checkpoints can never disagree.
        const deliveries = deliveriesByOrderItem.get(row.id) || [];
        let runningQty = 0;
        const deliveryPayload = deliveries.map((delivery) => {
          runningQty += Number(delivery.quantity_pcs || 0);
          return {
            challanId: delivery.challan_id,
            challanNo: delivery.challan_no || '',
            date: delivery.challan_date || '',
            status: delivery.challan_status || '',
            clientName: delivery.client_name || '',
            quantity: Number(delivery.quantity_pcs || 0),
            weight: Number(delivery.weight || 0),
            // Where the order stood once this challan went out — the position
            // its checkpoint is drawn at.
            cumulativeQty: runningQty,
          };
        });

        fulfilment.push({
          orderItemId: row.id,
          orderNo: row.order_no || '',
          orderedQty: Number(row.quantity || 0),
          orderedUnit: row.unit_symbol || '',
          deliveredQty: runningQty,
          deliveries: deliveryPayload,
          producedQty,
          producedUnit,
          scrapQty,
          runCount: runs.length,
          runStatus,
          templateName,
          startedAt,
          completedAt,
        });
      }

      res.json({ success: true, fulfilment, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        fulfilment: [],
        error: error.message,
      });
    }
  });

  app.get('/api/orders/:orderNo/pipeline-runs', requirePermission('config.read'), async (req, res) => {
    try {
      const orderNo = req.params.orderNo;
      const rows = await runsForOrderNo(orderNo);

      const runs = [];
      for (const row of rows) {
        runs.push(await rowToRun(row));
      }
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
      const header = await get(`
        SELECT h.order_no, h.po_number, c.name AS client_name
        FROM order_headers h
        LEFT JOIN clients c ON h.client_id = c.id
        WHERE h.order_no = ?
      `, [orderNo]);
      if (!header) {
        return res.status(404).json({ success: false, report: null, error: 'Order not found.' });
      }
      const items = await all(`
        SELECT id, item_name, variation_path_label, quantity, unit_name, unit_symbol, unit_price
        FROM order_items WHERE order_no = ? ORDER BY id ASC
      `, [orderNo]);
      const runRows = await runsForOrderNo(orderNo);
      const itemById = new Map(items.map((item) => [item.id, item]));
      const machineRows = await all('SELECT * FROM machines');
      const machineByKey = new Map();
      for (const row of machineRows) {
        const dto = machineRowToDto(row);
        [String(row.id), row.asset_id, row.name].forEach((key) => {
          if (key) machineByKey.set(String(key).trim(), dto);
        });
      }
      const dieRows = await all('SELECT * FROM dies');
      const dieByKey = new Map();
      for (const row of dieRows) {
        const dto = dieRowToDto(row);
        [String(row.id), row.tool_code].forEach((key) => {
          if (key) dieByKey.set(String(key).trim(), dto);
        });
      }

      const templateCache = new Map();
      const runs = [];
      for (const runRow of runRows) {
        if (!templateCache.has(runRow.template_id)) {
          templateCache.set(runRow.template_id, await get(
            'SELECT id, name, nodes_json FROM pipeline_templates WHERE id = ?',
            [runRow.template_id],
          ));
        }
        const template = templateCache.get(runRow.template_id);
        const nodes = template ? parseJson(template.nodes_json, []) : [];
        const metricsByNode = await getMergedNodeMetrics(runRow);
        const orderItem = itemById.get(runRow.order_item_id);
        const orderQty = Number(orderItem?.quantity || 0);
        const stages = nodes
          .slice()
          .sort((a, b) => (a.stageIndex || 0) - (b.stageIndex || 0))
          .map((node) => {
            const metrics = metricsByNode[node.id] || {};
            const machineKey = String(
              node.machineId || node.machine_id || node.machineAssetId || node.machine || node.machineName || ''
            ).trim();
            const dieKey = String(node.dieId || node.die_id || '').trim();
            const machine = machineByKey.get(machineKey) || null;
            const die = dieByKey.get(dieKey) || null;
            const quantityPerUnit = Number(
              node.quantityPerUnit ??
              node.quantity_per_unit ??
              node.inputItem?.quantityPerUnit ??
              node.inputItem?.quantity_per_unit ??
              node.inputItem?.perUnitQty ??
              NaN
            );
            const plannedMaterialQty = Number.isFinite(quantityPerUnit) && orderQty > 0
              ? quantityPerUnit * orderQty
              : null;
            return {
              nodeId: node.id,
              name: node.name || '',
              stageIndex: Number(node.stageIndex || 0),
              processType: node.processType || '',
              material: node.inputItem?.variationPathLabel || node.inputItem?.itemName || '',
              materialUnit: node.inputItem?.unitSymbol || '',
              outputName: node.outputItem?.variationPathLabel || node.outputItem?.itemName || '',
              outputUnit: node.outputItem?.unitSymbol || '',
              quantityPerUnit: Number.isFinite(quantityPerUnit) ? quantityPerUnit : null,
              plannedMaterialQty,
              machine: machine?.name || node.machine || node.machineGroupName || '',
              machineAssetId: machine?.assetId || machineKey,
              machineOutputPerHour: machine?.reportOutputPerHour ?? null,
              machineSetupMinutes: machine?.setupMinutes ?? null,
              machineLaborCount: machine?.laborCount ?? null,
              machinePowerKw: machine?.powerKw ?? null,
              machineReportNotes: machine?.reportNotes || '',
              dieId: dieKey,
              dieToolCode: die?.toolCode || dieKey,
              dieCavities: die?.numberOfCavities ?? null,
              dieMaxStrokes: die?.maxStrokes ?? null,
              dieStrokesPerPiece: die?.strokesPerPiece ?? null,
              dieSetupMinutes: die?.setupMinutes ?? null,
              dieReportNotes: die?.reportNotes || '',
              plannedHours: Number(node.durationHours || 0),
              allotted: metrics.allotted ?? null,
              output: metrics.output ?? metrics.goodYield ?? null,
              leftover: metrics.remaining ?? null,
              scrap: metrics.scrap ?? null,
              inputTime: metrics.inputTime ?? null,
              outputTime: metrics.outputTime ?? null,
              actualHours: metrics.actualHours ?? null,
            };
          });
        runs.push({
          runId: runRow.id,
          runName: runRow.name || '',
          status: runRow.status || 'planned',
          orderItemId: runRow.order_item_id,
          templateName: template?.name || '',
          startedAt: runRow.started_at,
          completedAt: runRow.completed_at,
          stages,
        });
      }

      res.json({
        success: true,
        report: {
          orderNo,
          clientName: header.client_name || '',
          poNumber: header.po_number || '',
          items: items.map((item) => ({
            orderItemId: item.id,
            itemName: item.item_name || '',
            variationPathLabel: item.variation_path_label || '',
            quantity: Number(item.quantity || 0),
            unitSymbol: item.unit_symbol || item.unit_name || 'pcs',
            unitPrice: Number(item.unit_price || 0),
          })),
          runs,
        },
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, report: null, error: error.message });
    }
  });

  function orderReturnRowToDto(r) {
    return {
      id: r.id,
      returnNo: r.return_no,
      orderNo: r.order_no,
      orderItemId: r.order_item_id ?? null,
      quantity: Number(r.quantity || 0),
      unit: r.unit || 'pcs',
      reasonCode: r.reason_code || 'defect',
      defectDescription: r.defect_description || '',
      status: r.status || 'open',
      returnedBarcode: r.returned_barcode || '',
      pipelineRunId: r.pipeline_run_id || null,
      loggedBy: r.logged_by || '',
      createdAt: r.created_at || null,
      updatedAt: r.updated_at || null,
    };
  }

  async function nextOrderReturnNo() {
    const row = await get('SELECT COUNT(*) AS n FROM order_returns');
    const year = new Date().getFullYear();
    return `RMA-${year}-${String((row?.n || 0) + 1).padStart(4, '0')}`;
  }

  // Customer return / defect events on an order (trace trigger).
  app.get('/api/orders/:orderNo/returns', requirePermission('config.read'), async (req, res) => {
    try {
      const rows = await all('SELECT * FROM order_returns WHERE order_no = ? ORDER BY created_at DESC', [req.params.orderNo]);
      res.json({ success: true, returns: rows.map(orderReturnRowToDto), error: null });
    } catch (error) {
      res.status(500).json({ success: false, returns: [], error: error.message });
    }
  });

  app.post('/api/orders/:orderNo/returns', requirePermission('config.write'), async (req, res) => {
    try {
      const orderNo = req.params.orderNo;
      const header = await get('SELECT order_no FROM order_headers WHERE order_no = ?', [orderNo]);
      if (!header) {
        return res.status(404).json({ success: false, return: null, error: 'Order not found.' });
      }
      const b = req.body || {};
      const actor = actorFromRequest(req);
      const now = new Date().toISOString();
      const returnNo = await nextOrderReturnNo();
      const info = await run(
        `
        INSERT INTO order_returns (
          return_no, order_no, order_item_id, quantity, unit, reason_code,
          defect_description, status, returned_barcode, logged_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
        `,
        [
          returnNo,
          orderNo,
          b.orderItemId ?? b.order_item_id ?? null,
          Number(b.quantity || 0),
          b.unit || 'pcs',
          b.reasonCode ?? b.reason_code ?? 'defect',
          b.defectDescription ?? b.defect_description ?? '',
          b.returnedBarcode ?? b.returned_barcode ?? '',
          actor?.name || null,
          now,
          now,
        ],
      );
      // Goods came back. This is the question the whole ledger exists to answer —
      // `order_returns`' own schema comment calls itself the trigger for the
      // backward QC lineage trace — and it recorded nothing.
      //
      // The subject is the returned piece when one was scanned, because that is
      // what someone holds when they ask what happened to it. The order goes in
      // `parents` and not only in `orderBarcode`: loadCustody matches on subject,
      // parents and children, so a code that appears only in `orderBarcode` is
      // invisible to a scan of the order — the return would be recorded and still
      // unreachable from the order it belongs to.
      const orderCode = barcodes.encode('ORD', orderNo);
      const returnedPiece = barcodes.normalize(b.returnedBarcode ?? b.returned_barcode ?? '');
      const returnSubject = returnedPiece || orderCode;
      await recordLedgerEvent({
        subjectBarcode: returnSubject,
        eventType: 'CUSTOMER_RETURN',
        actorName: actor?.name || 'Quality Control',
        orderBarcode: orderCode,
        parents: returnSubject === orderCode ? [] : [orderCode].filter(Boolean),
        metrics: {
          returnNo,
          qty: Number(b.quantity || 0),
          unit: b.unit || 'pcs',
          reasonCode: b.reasonCode ?? b.reason_code ?? 'defect',
          orderItemId: b.orderItemId ?? b.order_item_id ?? null,
          // Stated, so a reader can tell "returned without a code" from "returned
          // a piece we can trace" rather than inferring it from a subject shape.
          pieceIdentified: Boolean(returnedPiece),
        },
        notes: b.defectDescription ?? b.defect_description ?? '',
      });

      const row = await get('SELECT * FROM order_returns WHERE id = ?', [info.lastID]);
      res.status(201).json({ success: true, return: orderReturnRowToDto(row), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, return: null, error: error.message });
    }
  });

  // Backward QC lineage: reverses the production report and adds the exact
  // consumed vendor sheet(s) per run. Emits return events → runs → [die + machine]
  // stages → consumed sheets → vendor.
  app.get('/api/orders/:orderNo/trace', requirePermission('config.read'), async (req, res) => {
    try {
      const orderNo = req.params.orderNo;
      const header = await get(`
        SELECT h.order_no, c.name AS client_name
        FROM order_headers h LEFT JOIN clients c ON h.client_id = c.id
        WHERE h.order_no = ?
      `, [orderNo]);
      if (!header) {
        return res.status(404).json({ success: false, trace: null, error: 'Order not found.' });
      }
      const returns = (await all('SELECT * FROM order_returns WHERE order_no = ? ORDER BY created_at DESC', [orderNo]))
        .map(orderReturnRowToDto);
      const runRows = await runsForOrderNo(orderNo);

      const machineByKey = new Map();
      for (const row of await all('SELECT * FROM machines')) {
        const dto = machineRowToDto(row);
        [String(row.id), row.asset_id, row.name].forEach((k) => { if (k) machineByKey.set(String(k).trim(), dto); });
      }
      const dieByKey = new Map();
      for (const row of await all('SELECT * FROM dies')) {
        const dto = dieRowToDto(row);
        [String(row.id), row.tool_code].forEach((k) => { if (k) dieByKey.set(String(k).trim(), dto); });
      }

      const templateCache = new Map();
      const runs = [];
      const unresolved = [];
      for (const runRow of runRows) {
        if (!templateCache.has(runRow.template_id)) {
          templateCache.set(
            runRow.template_id,
            await get('SELECT nodes_json FROM pipeline_templates WHERE id = ?', [runRow.template_id]),
          );
        }
        const nodes = parseJson(templateCache.get(runRow.template_id)?.nodes_json, []);
        const overrides = parseJson(runRow.overrides_json, {});
        const stages = nodes
          .slice()
          .sort((a, b) => (a.stageIndex || 0) - (b.stageIndex || 0))
          .map((node) => {
            const overrideName = overrides.machineOverrideByNode?.[node.id];
            const machineKey = String(
              overrideName || node.machineId || node.machine_id || node.machineAssetId || node.machine || node.machineName || '',
            ).trim();
            const dieKey = String(node.dieId || node.die_id || '').trim();
            const machine = machineByKey.get(machineKey) || null;
            const die = dieByKey.get(dieKey) || null;
            return {
              nodeId: node.id,
              name: node.name || '',
              machineAssetId: machine?.assetId || machineKey || '',
              machineName: machine?.name || '',
              dieToolCode: die?.toolCode || dieKey || '',
            };
          });

        const { inputs } = await desk.ask('production.runs.inputs', { runId: runRow.id });
        const sheets = [];
        for (const inp of inputs) {
          if (inp.source_kind === 'sheet' && inp.piece_parent_code) {
            const sheet = await get(`
              SELECT pb.parent_code, pb.child_code, pb.weight,
                     c.vendor_id, c.vendor_name, c.challan_no AS reception_challan_no, c.date AS reception_date
              FROM piece_barcodes pb
              JOIN delivery_challan_items ci ON pb.challan_item_id = ci.id
              JOIN delivery_challans c ON ci.challan_id = c.id
              WHERE pb.parent_code = ? OR pb.child_code = ?
            `, [inp.piece_parent_code, inp.piece_parent_code]);
            sheets.push(sheet ? {
              parentCode: sheet.parent_code,
              childCode: sheet.child_code,
              weight: Number(sheet.weight || 0),
              vendorId: sheet.vendor_id || null,
              vendorName: sheet.vendor_name || '',
              receptionChallanNo: sheet.reception_challan_no || '',
              receptionDate: sheet.reception_date || '',
            } : {
              parentCode: inp.piece_parent_code,
              weight: Number(inp.consumed_weight || 0),
              retro: true,
            });
          } else {
            unresolved.push({ runId: runRow.id, barcode: inp.barcode, retro: true });
          }
        }
        runs.push({
          runId: runRow.id,
          runName: runRow.name || runRow.run_code || runRow.id,
          orderItemId: runRow.order_item_id,
          stages,
          sheets,
        });
      }

      res.json({
        success: true,
        trace: { orderNo, clientName: header.client_name || '', returns, runs, unresolved },
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, trace: null, error: error.message });
    }
  });
};
