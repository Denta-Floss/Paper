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
const crypto = require('crypto');

function createJobsWork({ run, jobs, desk }) {

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
      await run('ROLLBACK');
      return answer(500, { success: false, error: error.message });
    }
  }

  async function portalData(req) {
    try {
      const token = req.query.token;
      if (!token) return answer(400, { success: false, error: 'Missing token' });

      const SECRET = 'my-very-secret-key-32charslong!!';
      let barcode_id;
      try {
        const parts = token.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const encryptedText = Buffer.from(parts[1], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(SECRET), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        barcode_id = decrypted.toString();
      } catch (e) {
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
    portalData,
  };
}

module.exports = { createJobsWork };
