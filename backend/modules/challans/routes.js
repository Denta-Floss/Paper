'use strict';

// ---------------------------------------------------------------------------
// Challans over HTTP.
//
// Every route below except the four marked * is registered twice, under
// /api/challans and /api/delivery-challans, from one handler.
//
//   GET    …                          the list
//   POST   …                          create a draft
//   GET    …/:id                      one
//   PUT    …/:id                      edit
//   DELETE …/:id                      remove a draft
//   POST   …/:id/issue                issue it: freezes the snapshot, moves stock
//   POST   …/:id/cancel               cancel it and put stock back
//   GET    …/:id/cancel-options       what stands in the way (linked invoices)
//   PATCH  …/:id/report-groups        which report groups it counts in
//   POST   …/:id/print                record that it was printed
//   POST   …/:id/reconcile            settle an internal-use challan into scrap,
//                                     leftover, lost, rejection and finished goods
//   POST   /api/challans/:id/piece-barcodes *            per-piece barcodes
//   POST   /api/delivery-challans/:id/assets/upload-intent *
//   POST   /api/delivery-challans/:id/assets/upload-complete *
//   GET    /api/orders/:orderId/delivery-challans *      an order's challans
//
// `challans` and `delivery-challans` map to the challans module in the central
// gate (reconcile to challans.reconcile); the order-path route is gated as
// orders.
//
// NOT here: GET /api/delivery-challans/health stays in server.js, ahead of the
// login gate.
//
// A challan's photo upload finishes through completeAssetUpload, the same
// function every other record uses.
// ---------------------------------------------------------------------------
//
// Every route here asks the module's operations (./operations.js) at the kernel
// desk; the work is in ./work.js. A handler names the operation,
// picks its input out of the request, and sends the result back as the answer
// the app has always had.

const { deskRoutes } = require('../../kernel/desk-kit');

module.exports = function registerChallanRoutes(ctx) {
  const { app, desk, requirePermission, cacheMasterData } = ctx;
  const send = deskRoutes(desk);

  app.get('/api/challans', requirePermission('config.read'), cacheMasterData,
    send('challans.list', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/delivery-challans', requirePermission('config.read'), cacheMasterData,
    send('challans.list', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/challans', requirePermission('config.write'),
    send('challans.create', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/delivery-challans', requirePermission('config.write'),
    send('challans.create', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/challans/:id/piece-barcodes', requirePermission('config.write'),
    send('challans.pieceBarcodes.add', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/orders/:orderId/delivery-challans', requirePermission('config.read'),
    send('challans.listForOrder', (req) => ({ orderId: req.params.orderId, query: req.query, data: req.body })));

  app.get('/api/challans/:id', requirePermission('config.read'),
    send('challans.get', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/delivery-challans/:id', requirePermission('config.read'),
    send('challans.get', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.put('/api/challans/:id', requirePermission('config.write'),
    send('challans.update', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.put('/api/delivery-challans/:id', requirePermission('config.write'),
    send('challans.update', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/challans/:id/issue', requirePermission('config.write'),
    send('challans.issue', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/delivery-challans/:id/issue', requirePermission('config.write'),
    send('challans.issue', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/challans/:id/reconcile', requirePermission('config.write'),
    send('challans.reconcile', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/delivery-challans/:id/reconcile', requirePermission('config.write'),
    send('challans.reconcile', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/challans/:id/cancel', requirePermission('config.write'),
    send('challans.cancel', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/delivery-challans/:id/cancel', requirePermission('config.write'),
    send('challans.cancel', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/challans/:id/cancel-options', requirePermission('config.write'),
    send('challans.cancelOptions', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/delivery-challans/:id/cancel-options', requirePermission('config.write'),
    send('challans.cancelOptions', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.patch('/api/challans/:id/report-groups', requirePermission('config.write'),
    send('challans.setReportGroups', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.patch('/api/delivery-challans/:id/report-groups', requirePermission('config.write'),
    send('challans.setReportGroups', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/challans/:id/print', requirePermission('config.write'),
    send('challans.print', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/delivery-challans/:id/print', requirePermission('config.write'),
    send('challans.print', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.delete('/api/challans/:id', requirePermission('config.write'),
    send('challans.delete', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.delete('/api/delivery-challans/:id', requirePermission('config.write'),
    send('challans.delete', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/delivery-challans/:id/assets/upload-intent', requirePermission('config.write'),
    send('challans.assets.uploadIntent', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/delivery-challans/:id/assets/upload-complete', requirePermission('config.write'),
    send('challans.assets.uploadComplete', (req) => ({ id: req.params.id, query: req.query, data: req.body })));
};
