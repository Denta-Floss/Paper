'use strict';

// ---------------------------------------------------------------------------
// What other modules may ask of the production module.
//
// Production owns pipeline_runs, run_barcode_inputs, production_runs,
// production_scrap, stage_reconciliations and order_pipeline_assignments. Another module that needs to
// know something about a run, or to remove one, asks here and carries no SQL
// against those tables.
//
//   runs.rowById(runId)                  one pipeline run's row
//   runs.dissolve(runId)                 remove a run and the stock inputs on
//                                        it (an order line being deleted)
//   runs.inputCountForBarcode(barcode)   how many run inputs name a material
//   runs.latestInputForBarcode(barcode)  the last run and node a material went to
//   runs.stagesForRun(runId)             a run's stage reconciliation rows
//   runs.linkedToOrderItem, unlinkOrderItem, orderItemIdsForRun, allWithOrderItem,
//   runs.forOrderItems, summariesForOrderItems, inputsForRun, inputsForRuns,
//   runs.stageTotalsForRuns             runs seen from the order side, for
//                                        orders, inventory and the reports
//   orderItemRunStatusSql(expr)          (module export) the SQL the order list
//                                        embeds for a line's status from its runs
//   output.sourceById(productionRunId)   a finished run's code and where it came from
//   runInputsForChallanLines(lineIds)    what runs have claimed from reception lines
//   machineAssignedToActiveRun, dieAssignedToActiveRun, templateRunCount

// ---------------------------------------------------------------------------

function createProductionPorts({ get, all, run }) {
  /// Whether a live run (planned, in progress or paused) names this id in one
  /// of its per-node overrides. `id` is the id as the URL carries it, a string:
  /// that is how run overrides store it. `overrideKey` says which map to look in.
  async function assignedToActiveRun(id, overrideKey) {
    const activeRuns = await all(
      "SELECT overrides_json FROM pipeline_runs WHERE status IN ('planned', 'in_progress', 'paused')",
    );
    for (const activeRun of activeRuns) {
      if (activeRun.overrides_json && activeRun.overrides_json.includes(`"${id}"`)) {
        // Double check by parsing
        const overrides = JSON.parse(activeRun.overrides_json);
        if (overrides[overrideKey] && Object.values(overrides[overrideKey]).includes(id)) {
          return true;
        }
      }
    }
    return false;
  }

  return {
    runs: {
      rowById: (runId) => get('SELECT * FROM pipeline_runs WHERE id = ?', [runId]),

      /// Removes a run and the stock inputs recorded on it. The caller has
      /// already put the consumed stock back.
      async dissolve(runId) {
        await run('DELETE FROM run_barcode_inputs WHERE run_id = ?', [runId]);
        await run('DELETE FROM pipeline_runs WHERE id = ?', [runId]);
      },

      async inputCountForBarcode(barcode) {
        const row = await get(
          'SELECT COUNT(*) AS count FROM run_barcode_inputs WHERE barcode = ?',
          [barcode],
        );
        return Number(row?.count || 0);
      },

      latestInputForBarcode: (barcode) => get(
        'SELECT run_id, node_id FROM run_barcode_inputs WHERE barcode = ? ORDER BY scanned_at DESC LIMIT 1',
        [barcode],
      ),

      stagesForRun: (runId) => all('SELECT * FROM stage_reconciliations WHERE run_id = ?', [runId]),

      // --- runs and the order lines they were started for -------------------
      // order_pipeline_assignments is production's: a run is linked to the
      // order lines it makes when it is created.

      /// The links from one order line to its runs.
      linkedToOrderItem: (orderItemId) =>
        all('SELECT * FROM order_pipeline_assignments WHERE order_item_id = ?', [orderItemId]),

      /// Forgets an order line's runs (the line is being deleted).
      unlinkOrderItem: (orderItemId) =>
        run('DELETE FROM order_pipeline_assignments WHERE order_item_id = ?', [orderItemId]),

      orderItemIdsForRun: (runId) =>
        all('SELECT order_item_id FROM order_pipeline_assignments WHERE pipeline_run_id = ?', [runId]),

      /// Every linked run, one row per link, with the order line it is for.
      allWithOrderItem: () => all(`
        SELECT opa.order_item_id, pr.*
        FROM order_pipeline_assignments opa
        JOIN pipeline_runs pr ON pr.id = opa.pipeline_run_id
      `),

      /// The runs of these order lines, newest first, one row per link, each
      /// with its `order_item_id`.
      forOrderItems(orderItemIds) {
        const ids = (orderItemIds || []).map((id) => Number(id)).filter((id) => id > 0);
        if (ids.length === 0) return Promise.resolve([]);
        return all(
          `SELECT pr.*, opa.order_item_id
             FROM pipeline_runs pr
             JOIN order_pipeline_assignments opa ON pr.id = opa.pipeline_run_id
            WHERE opa.order_item_id IN (${ids.map(() => '?').join(', ')})
            ORDER BY pr.created_at DESC`,
          ids,
        );
      },

      /// The same runs once each, with only what a summary needs.
      summariesForOrderItems(orderItemIds) {
        const ids = (orderItemIds || []).map((id) => Number(id)).filter((id) => id > 0);
        if (ids.length === 0) return Promise.resolve([]);
        return all(
          `
          SELECT DISTINCT r.id, r.status, r.started_at, r.completed_at, r.name
          FROM order_pipeline_assignments a
          JOIN pipeline_runs r ON r.id = a.pipeline_run_id
          WHERE a.order_item_id IN (${ids.map(() => '?').join(', ')})
          `,
          ids,
        );
      },

      inputsForRun: (runId) => all('SELECT * FROM run_barcode_inputs WHERE run_id = ?', [runId]),

      /// What these runs consumed, oldest first.
      inputsForRuns(runIds) {
        if (!runIds || runIds.length === 0) return Promise.resolve([]);
        return all(
          `
          SELECT rbi.run_id, rbi.barcode, rbi.material_id, rbi.scanned_at,
                 rbi.challan_item_id, rbi.item_id, rbi.variation_leaf_node_id,
                 rbi.consumed_qty, rbi.source_kind
          FROM run_barcode_inputs rbi
          WHERE rbi.run_id IN (${runIds.map(() => '?').join(', ')})
          ORDER BY rbi.scanned_at ASC
          `,
          runIds,
        );
      },

      /// Allotted, output, scrap and leftover summed over these runs' stages.
      stageTotalsForRuns(runIds) {
        return get(
          `
          SELECT COALESCE(SUM(allotted), 0) AS allotted,
                 COALESCE(SUM(output), 0) AS output,
                 COALESCE(SUM(scrap), 0) AS scrap,
                 COALESCE(SUM(leftover), 0) AS leftover
          FROM stage_reconciliations
          WHERE run_id IN (${runIds.map(() => '?').join(', ')})
          `,
          runIds,
        );
      },
    },

    output: {
      sourceById: (productionRunId) => get(
        'SELECT run_code, source_metadata_json FROM production_runs WHERE id = ?',
        [productionRunId],
      ),
    },

    /// Whether a live run has this machine assigned to any of its nodes.
    machineAssignedToActiveRun: (machineId) =>
      assignedToActiveRun(machineId, 'machineOverrideByNode'),

    /// Whether a live run has this die assigned to any of its nodes.
    dieAssignedToActiveRun: (dieId) =>
      assignedToActiveRun(dieId, 'dieOverrideByNode'),

    /// How many runs, ongoing or finished, were started from this template.
    /// A template with any cannot be deleted: its history would lose its source.
    /// What runs have claimed from these reception challan lines WITHOUT the
    /// received material's stock position showing it:
    ///   'sheet'     a vendor sheet scanned before sheets consumed stock, or
    ///               one whose material had nothing on hand (consumed_qty 0)
    ///   'quantity'  an issue by quantity (no movement)
    ///   'barcode'   the material assigned to a run with no quantity yet, so
    ///               nothing was consumed but the run has claimed it
    /// A material assigned WITH a quantity is not here: that goes through the
    /// movement ledger and the position already shows it. One row per line and
    /// kind: `{ challan_item_id, source_kind, inputs, qty, weight }`.
    async runInputsForChallanLines(lineIds) {
      const ids = [...new Set((lineIds || []).map((id) => Number(id)).filter((id) => id > 0))];
      if (ids.length === 0) return [];
      return all(
        `SELECT challan_item_id, source_kind, COUNT(*) AS inputs,
                COALESCE(SUM(consumed_qty), 0) AS qty,
                COALESCE(SUM(consumed_weight), 0) AS weight
           FROM run_barcode_inputs
          WHERE challan_item_id IN (${ids.map(() => '?').join(',')})
            AND (source_kind = 'quantity'
                 OR (source_kind IN ('sheet', 'barcode') AND COALESCE(consumed_qty, 0) = 0))
          GROUP BY challan_item_id, source_kind`,
        ids,
      );
    },

    async templateRunCount(templateId) {
      const row = await get(
        'SELECT COUNT(*) as count FROM pipeline_runs WHERE template_id = ?',
        [templateId],
      );
      return Number((row && row.count) || 0);
    },
  };
}

/// SQL for "what do this order line's runs say its status is": completed when
/// every run is, in progress once any has started, not started otherwise, and
/// NULL when the line has no runs. `orderItemIdSql` is the SQL expression for
/// the order line's id in the caller's query. It is handed out as text because
/// the order list filters, counts and pages on this value inside one query;
/// asking per row would turn one statement into one per order line.
function orderItemRunStatusSql(orderItemIdSql) {
  return `(SELECT 
            CASE 
              WHEN COUNT(opa.id) = 0 THEN NULL
              WHEN SUM(CASE WHEN pr.status = 'completed' THEN 1 ELSE 0 END) = COUNT(opa.id) THEN 'completed'
              WHEN SUM(CASE WHEN pr.started_at IS NOT NULL THEN 1 ELSE 0 END) > 0 THEN 'inProgress'
              ELSE 'notStarted'
            END
           FROM order_pipeline_assignments opa
           JOIN pipeline_runs pr ON opa.pipeline_run_id = pr.id
           WHERE opa.order_item_id = ${orderItemIdSql}
          )`;
}

module.exports = { createProductionPorts, orderItemRunStatusSql };
