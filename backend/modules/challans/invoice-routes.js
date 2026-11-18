'use strict';


// ---------------------------------------------------------------------------
// Invoices over HTTP.
//
//   GET    /api/invoices              the list
//   GET    /api/invoices/:id          one, with its lines
//   GET    /api/invoices/:id/pdf      the printable invoice
//   POST   /api/invoices              raise one (records INVOICED in the custody
//                                     ledger once per distinct challan billed)
//   PATCH  /api/invoices/:id/status   move its status
//   PUT    /api/invoices/:id          edit it
//   DELETE /api/invoices/:id          remove it
//
// `invoices` is a first path segment the central CRUD gate maps to challans.
// Handlers are the ones that lived in server.js, moved whole.
//
// PUT replaces the invoice's lines and recomputes its totals in one transaction.
// (It used to call a `prepare` helper that did not exist, so every edit failed.)
// ---------------------------------------------------------------------------
//
// Every route here asks the module's operations (./operations.js) at the kernel
// desk; the work is in ./invoice-work.js. A handler names the operation,
// picks its input out of the request, and sends the result back as the answer
// the app has always had.

const { deskRoutes } = require('../../kernel/desk-kit');

module.exports = function registerInvoiceRoutes(ctx) {
  const { app, desk, requirePermission } = ctx;
  const send = deskRoutes(desk);

  app.get('/api/invoices', requirePermission('config.read'),
    send('challans.invoices.list', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/invoices/:id', requirePermission('config.read'),
    send('challans.invoices.get', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/invoices/:id/pdf', requirePermission('config.read'),
    send('challans.invoices.pdf', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.patch('/api/invoices/:id/status', requirePermission('config.write'),
    send('challans.invoices.setStatus', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.put('/api/invoices/:id', requirePermission('config.write'),
    send('challans.invoices.update', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.delete('/api/invoices/:id', requirePermission('config.write'),
    send('challans.invoices.delete', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/invoices', requirePermission('config.write'),
    send('challans.invoices.create', (req) => ({ query: req.query, data: req.body })));
};
