'use strict';

// ---------------------------------------------------------------------------
// What other modules may ask of the production module.
//
// Production (runs, node status, scrap) is still in server.js, so this is a thin
// reader over its tables, not yet a boundary with a service behind it. It exists
// so a module that has left (machines today) does not carry SQL against
// `pipeline_runs`. When production moves, this file is the contract it keeps.
// Read-only on purpose.
// ---------------------------------------------------------------------------

function createProductionPorts({ all }) {
  return {
    /// Whether a live run (planned, in progress or paused) has this machine
    /// assigned to any of its nodes. `machineId` is the id as the URL carries
    /// it, a string: that is how run overrides store it.
    async machineAssignedToActiveRun(machineId) {
      const activeRuns = await all(
        "SELECT overrides_json FROM pipeline_runs WHERE status IN ('planned', 'in_progress', 'paused')",
      );
      for (const activeRun of activeRuns) {
        if (activeRun.overrides_json && activeRun.overrides_json.includes(`"${machineId}"`)) {
          // Double check by parsing
          const overrides = JSON.parse(activeRun.overrides_json);
          if (
            overrides.machineOverrideByNode &&
            Object.values(overrides.machineOverrideByNode).includes(machineId)
          ) {
            return true;
          }
        }
      }
      return false;
    },
  };
}

module.exports = { createProductionPorts };
