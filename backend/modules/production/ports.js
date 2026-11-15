'use strict';

// ---------------------------------------------------------------------------
// What other modules may ask of the production module.
//
// Production owns pipeline_runs, run_barcode_inputs, production_runs,
// production_scrap and stage_reconciliations. Another module that needs to
// know something about a run, or to remove one, asks here and carries no SQL
// against those tables.
//
//   runs.rowById(runId)                  one pipeline run's row
//   runs.dissolve(runId)                 remove a run and the stock inputs on
//                                        it (an order line being deleted)
//   runs.inputCountForBarcode(barcode)   how many run inputs name a material
//   runs.latestInputForBarcode(barcode)  the last run and node a material went to
//   runs.stagesForRun(runId)             a run's stage reconciliation rows
//   output.sourceById(productionRunId)   a finished run's code and where it came from
//   runInputsForChallanLines(lineIds)    what runs have claimed from reception lines
//   machineAssignedToActiveRun, dieAssignedToActiveRun, templateRunCount
//
// The order and challan reports read these tables directly, as read models.
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

module.exports = { createProductionPorts };
