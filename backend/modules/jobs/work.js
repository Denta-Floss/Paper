'use strict';

// ---------------------------------------------------------------------------
// What the handlers in routes.js did, statement for statement. Instead of
// writing a response each returns answer(status, body), the same status and
// the same body (or answerFile for a download). A function takes a plain
// `req` with `params`, `query`, `body` and `user`.
//
// ./operations.js publishes these at the kernel desk; ./routes.js asks the desk.
// ---------------------------------------------------------------------------

const { answer, answerFile } = require('../../kernel/desk-kit');

function createJobsWork({ run, jobs, desk, portalTokens }) {

  async function listJobs(req) {
    try {
      const { jobs: jobRows, tasks, batches } = await jobs.listAll();
      return answer(200, { success: true, jobs: jobRows, tasks, batches });
    } catch (error) {
      return answer(500, { success: false, jobs: [], error: error.message });
    }
  }

  async function createJobBatches(req) {
    try {
      const { freelancer_id, job_ids } = req.body;
      const batch = await jobs.createBatch(freelancer_id, job_ids);
      return answer(200, { success: true, batch });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  async function createJob(req) {
    try {
      const { item_id, quantity } = req.body;
      const job = await jobs.createJob(item_id, quantity);
      return answer(200, { success: true, job });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  async function updateJob(req) {
    try {
      const { status } = req.body;
      const updated = await jobs.setStatus(req.params.id, status);
      return answer(200, { success: true, job: updated });
    } catch (error) {
      return answer(500, { success: false, job: null, error: error.message });
    }
  }

  async function deleteJob(req) {
    try {
      await jobs.deleteJob(req.params.id);
      return answer(200, { success: true, error: null });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  /// The token that goes on a worker's printed card, for whoever prints it.
  async function portalToken(req) {
    try {
      const barcodeId = String(req.query.barcodeId || '').trim();
      if (!barcodeId) return answer(400, { success: false, error: 'barcodeId is required' });
      return answer(200, { success: true, token: portalTokens.make(barcodeId) });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  async function portalData(req) {
    try {
      const token = req.query.token;
      if (!token) return answer(400, { success: false, error: 'Missing token' });

      // The token is made by this server (portalToken below) and signed with
      // its own secret. Cards printed before that carried the barcode
      // encrypted with a key that was written in the source; those no longer
      // open anything, and have to be printed again.
      const barcode_id = portalTokens.read(token);
      if (barcode_id === null) {
        return answer(400, { success: false, error: 'Invalid or tampered token' });
      }

      const { employeeId } = await desk.ask('people.employees.idByBarcode', { barcodeId: barcode_id });
      if (employeeId === null) return answer(404, { success: false, error: 'Freelancer not found' });

      const { batches, jobs: jobRows, tasks } = await jobs.dataForFreelancer(employeeId);
      return answer(200, { success: true, batches, jobs: jobRows, tasks });
    } catch (error) {
      return answer(500, { success: false, error: error.message });
    }
  }

  return {
    listJobs,
    createJobBatches,
    createJob,
    updateJob,
    deleteJob,
    portalToken,
    portalData,
  };
}

module.exports = { createJobsWork };
