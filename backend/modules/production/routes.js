'use strict';

// ---------------------------------------------------------------------------
// Production routes.
//
//   GET    /runs                       runs, optionally for one template
//   POST   /runs                       start a run from a template
//   GET    /runs/:id                   one run
//   DELETE /runs/:id                   a run, with its inputs and scrap rows
//   PUT    /runs/:id/node-status       a node's status; completing the last
//                                      node books and mints the output
//   POST   /runs/:id/barcodes          stock put on a node: a material, a
//                                      vendor sheet, or a quantity split over
//                                      the barcodes that hold the item
//   PUT    /runs/:id/barcodes[/:nodeId/:barcode]     change what was taken
//   DELETE /runs/:id/barcodes[/:nodeId/:barcode]     take it back off
//   PUT    /runs/:id/node-metrics      a stage's reconciliation numbers
//   PUT    /runs/:id/batches           the run's batches, as the client keeps them
//   POST   /api/production-scrap       scrap booked against a run
//   GET    /api/production-scrap
//   GET    /api/production-runs/completed            finished output, for a challan
//   GET    /api/machines/:id/queue     the live runs that name a machine
//   GET    /api/items/:id/pipeline-history           the runs that made an item
//
// The login and write-permission guards for /runs are app.use lines in
// server.js, registered ahead of this module; the /api routes carry their own
// permission check.
//
// Every route asks the module's operations (./operations.js) at the kernel
// desk. The work itself is in ./work.js. A handler here only names the
// operation, picks its input out of the request, and sends the result back as
// the answer the app has always had: same status, same body.
// ---------------------------------------------------------------------------

function registerProductionRoutes(app, { desk, requirePermission }) {
  /// One route: ask `operation` with what `inputOf(req)` picks out, and answer.
  const send = (operation, inputOf) => async (req, res) => {
    try {
      const result = await desk.call(operation, inputOf(req), { actor: desk.actorFromRequest(req) });
      const { ok, status, httpStatus, ...body } = result;
      // `success` is in `body` only when it was not simply "did it work".
      res.status(ok ? httpStatus || 200 : status || 400).json({ success: ok, ...body });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  };

  // Where a stock change says which node and barcode it means: the path, then
  // the query. (The body is looked at last, by the work itself.)
  const stockTarget = (req) => ({
    runId: req.params.id,
    nodeId: req.params.nodeId || req.query.nodeId,
    barcode: req.params.barcode || req.query.barcode,
    data: req.body,
  });

  app.get('/api/production-runs/completed', requirePermission('config.read'),
    send('production.output.completed', (req) => ({
      search: req.query.search,
      q: req.query.q,
      limit: req.query.limit,
    })));

  app.get('/api/machines/:id/queue', requirePermission('config.read'),
    send('production.machines.queue', (req) => ({ machineId: req.params.id })));

  app.delete('/runs/:id',
    send('production.runs.delete', (req) => ({ runId: req.params.id })));

  app.get('/api/items/:id/pipeline-history', requirePermission('config.read'),
    send('production.items.pipelineHistory', (req) => ({ itemId: req.params.id })));

  app.get('/runs', requirePermission('config.read'),
    send('production.runs.list', (req) => ({ templateId: req.query.template_id })));

  app.post('/runs',
    send('production.runs.start', (req) => ({ data: req.body })));

  app.get('/runs/:id', requirePermission('config.read'),
    send('production.runs.get', (req) => ({ runId: req.params.id })));

  app.put('/runs/:id/node-status',
    send('production.runs.setNodeStatus', (req) => ({ runId: req.params.id, data: req.body })));

  app.post('/runs/:id/barcodes',
    send('production.runs.assignStock', (req) => ({ runId: req.params.id, data: req.body })));

  app.put(['/runs/:id/barcodes', '/runs/:id/barcodes/:nodeId/:barcode'],
    send('production.runs.changeStock', (req) => ({ ...stockTarget(req), quantity: req.query.quantity })));

  app.delete(['/runs/:id/barcodes', '/runs/:id/barcodes/:nodeId/:barcode'],
    send('production.runs.removeStock', stockTarget));

  app.put('/runs/:id/node-metrics',
    send('production.runs.setNodeMetrics', (req) => ({ runId: req.params.id, data: req.body })));

  app.put('/runs/:id/batches',
    send('production.runs.setBatches', (req) => ({ runId: req.params.id, data: req.body })));

  app.post('/api/production-scrap', requirePermission('config.write'),
    send('production.scrap.record', (req) => ({ data: req.body })));

  app.get('/api/production-scrap', requirePermission('config.read'),
    send('production.scrap.list', (req) => ({
      pipelineRunId: req.query.pipelineRunId,
      nodeId: req.query.nodeId,
    })));
}

module.exports = { registerProductionRoutes };
