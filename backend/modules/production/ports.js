'use strict';

// ---------------------------------------------------------------------------
// What other modules may ask of the production module.
//
// Production (runs, node status, scrap) is still in server.js, so this is a thin
// reader over its tables, not yet a boundary with a service behind it. It exists
// so modules that have left (machines, dies, pipelines) do not carry SQL against
// `pipeline_runs`. When production moves, this file is the contract it keeps.
// Read-only on purpose.
// ---------------------------------------------------------------------------

function createProductionPorts({ get, all }) {
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
    /// Whether a live run has this machine assigned to any of its nodes.
    machineAssignedToActiveRun: (machineId) =>
      assignedToActiveRun(machineId, 'machineOverrideByNode'),

    /// Whether a live run has this die assigned to any of its nodes.
    dieAssignedToActiveRun: (dieId) =>
      assignedToActiveRun(dieId, 'dieOverrideByNode'),

    /// How many runs, ongoing or finished, were started from this template.
    /// A template with any cannot be deleted: its history would lose its source.
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
