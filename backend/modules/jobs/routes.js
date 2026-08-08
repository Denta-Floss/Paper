'use strict';

// ---------------------------------------------------------------------------
// Jobs module — HTTP routes.
//
// All 5 route registrations for jobs territory (freelancer-jobs) moved
// VERBATIM from server.js. No logic edits; handler bodies are NOT re-indented.
// Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerJobsModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
    createFreelancerJobWithTasks,
  } = ctx;

app.get('/api/freelancer-jobs', requirePermission('config.read'), async (req, res) => {
  try {
    const jobs = await all('SELECT * FROM freelancer_jobs');
    const tasks = await all('SELECT * FROM freelancer_job_tasks');
    const batches = await all('SELECT * FROM freelancer_job_batches');
    res.json({ success: true, jobs, tasks, batches });
  } catch (error) {
    res.status(500).json({ success: false, jobs: [], error: error.message });
  }
});

app.post('/api/freelancer-jobs/batches', requirePermission('config.write'), async (req, res) => {
  try {
    const { freelancer_id, job_ids } = req.body;
    const batch_number = 'BATCH-' + Date.now();
    const result = await run(
      'INSERT INTO freelancer_job_batches (freelancer_id, batch_number, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [freelancer_id, batch_number, 'assigned', new Date().toISOString(), new Date().toISOString()]
    );
    const batch_id = result.lastID;
    
    for (const jid of job_ids) {
      await run('UPDATE freelancer_jobs SET batch_id = ?, updated_at = ? WHERE id = ?', [batch_id, new Date().toISOString(), jid]);
    }
    
    const batch = await get('SELECT * FROM freelancer_job_batches WHERE id = ?', [batch_id]);
    res.json({ success: true, batch });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/freelancer-jobs', requirePermission('config.write'), async (req, res) => {
  try {
    const { item_id, quantity } = req.body;
    const job = await createFreelancerJobWithTasks({ item_id, quantity });
    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/freelancer-jobs/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const { status } = req.body;
    await run(
      'UPDATE freelancer_jobs SET status = ?, updated_at = ? WHERE id = ?',
      [status, new Date().toISOString(), req.params.id]
    );
    const updated = await get('SELECT * FROM freelancer_jobs WHERE id = ?', [req.params.id]);
    res.json({ success: true, job: updated });
  } catch (error) {
    res.status(500).json({ success: false, job: null, error: error.message });
  }
});

app.delete('/api/freelancer-jobs/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = req.params.id;
    await run('BEGIN TRANSACTION');
    await run('DELETE FROM freelancer_job_tasks WHERE job_id = ?', [id]);
    await run('DELETE FROM freelancer_jobs WHERE id = ?', [id]);
    await run('COMMIT');
    res.json({ success: true, error: null });
  } catch (error) {
    await run('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  }
});

};
