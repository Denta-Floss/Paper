'use strict';


// ---------------------------------------------------------------------------
// The freelancer job pool over HTTP.
//
//   GET    /api/freelancer-jobs                 the board: jobs, tasks, batches
//   POST   /api/freelancer-jobs                 raise a job by hand
//   POST   /api/freelancer-jobs/batches         hand jobs to a worker
//   PUT    /api/freelancer-jobs/:id             move a job's status
//   DELETE /api/freelancer-jobs/:id             remove a job and its tasks
//   GET    /api/freelancer-jobs/portal-token    the token for a worker's card
//   GET    /api/freelancer-portal/data          one worker's card, by token
//
// Handlers are the ones that lived in server.js, moved whole. The worker's
// employee row is asked of the people module at the kernel desk, not read from `employees`.
//
// Neither segment is a registry path segment the central gate knows
// (`jobs` is, `freelancer-jobs` and `freelancer-portal` are not), so these
// routes are gated by the legacy write gate and their own requirePermission
// calls, exactly as before the move.
// ---------------------------------------------------------------------------

const { deskRoutes } = require('../../kernel/desk-kit');

module.exports = function registerJobsRoutes(ctx) {
  const { app, desk, requirePermission } = ctx;
  const send = deskRoutes(desk);

  app.get('/api/freelancer-jobs', requirePermission('config.read'),
    send('jobs.list', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/freelancer-jobs/batches', requirePermission('config.write'),
    send('jobs.batches.create', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/freelancer-jobs', requirePermission('config.write'),
    send('jobs.create', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/freelancer-jobs/portal-token', requirePermission('config.read'),
    send('jobs.portalToken', (req) => ({ query: req.query, data: req.body })));

  app.put('/api/freelancer-jobs/:id', requirePermission('config.write'),
    send('jobs.update', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.delete('/api/freelancer-jobs/:id', requirePermission('config.write'),
    send('jobs.delete', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/freelancer-portal/data',
    send('jobs.portalData', (req) => ({ query: req.query, data: req.body })));
};
