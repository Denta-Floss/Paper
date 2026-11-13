'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// The freelancer job pool over HTTP.
//
//   GET    /api/freelancer-jobs                 the board: jobs, tasks, batches
//   POST   /api/freelancer-jobs                 raise a job by hand
//   POST   /api/freelancer-jobs/batches         hand jobs to a worker
//   PUT    /api/freelancer-jobs/:id             move a job's status
//   DELETE /api/freelancer-jobs/:id             remove a job and its tasks
//   GET    /api/freelancer-portal/data          one worker's card, by token
//
// Handlers are the ones that lived in server.js, moved whole. The worker's
// employee row is read through the people port rather than from `employees`.
//
// Neither segment is a registry path segment the central gate knows
// (`jobs` is, `freelancer-jobs` and `freelancer-portal` are not), so these
// routes are gated by the legacy write gate and their own requirePermission
// calls, exactly as before the move.
// ---------------------------------------------------------------------------

module.exports = function registerJobsRoutes(ctx) {
  const { app, requirePermission, run, jobs, people } = ctx;

  app.get('/api/freelancer-jobs', requirePermission('config.read'), async (req, res) => {
    try {
      const { jobs: jobRows, tasks, batches } = await jobs.listAll();
      res.json({ success: true, jobs: jobRows, tasks, batches });
    } catch (error) {
      res.status(500).json({ success: false, jobs: [], error: error.message });
    }
  });

  app.post('/api/freelancer-jobs/batches', requirePermission('config.write'), async (req, res) => {
    try {
      const { freelancer_id, job_ids } = req.body;
      const batch = await jobs.createBatch(freelancer_id, job_ids);
      res.json({ success: true, batch });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/freelancer-jobs', requirePermission('config.write'), async (req, res) => {
    try {
      const { item_id, quantity } = req.body;
      const job = await jobs.createJob(item_id, quantity);
      res.json({ success: true, job });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.put('/api/freelancer-jobs/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const { status } = req.body;
      const updated = await jobs.setStatus(req.params.id, status);
      res.json({ success: true, job: updated });
    } catch (error) {
      res.status(500).json({ success: false, job: null, error: error.message });
    }
  });

  app.delete('/api/freelancer-jobs/:id', requirePermission('config.write'), async (req, res) => {
    try {
      await jobs.deleteJob(req.params.id);
      res.json({ success: true, error: null });
    } catch (error) {
      await run('ROLLBACK');
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/freelancer-portal/data', async (req, res) => {
    try {
      const token = req.query.token;
      if (!token) return res.status(400).json({ success: false, error: 'Missing token' });

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
        return res.status(400).json({ success: false, error: 'Invalid or tampered token' });
      }

      const employeeId = await people.employeeIdByBarcode(barcode_id);
      if (employeeId === null) return res.status(404).json({ success: false, error: 'Freelancer not found' });

      const { batches, jobs: jobRows, tasks } = await jobs.dataForFreelancer(employeeId);
      res.json({ success: true, batches, jobs: jobRows, tasks });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
};
