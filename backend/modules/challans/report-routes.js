'use strict';

// ---------------------------------------------------------------------------
// Challan reports over HTTP.
//
//   GET   /api/reconciliation/report                 issued against billed
//   GET   /api/reconciliation/conversion-overrides   the ratios in force
//   PATCH /api/reconciliation/conversion-overrides   set one
//   GET   /api/reconciliation/waste-audit            what the report wrote off
//   POST  /api/reports/client-statement              a client's statement
//   GET   /api/orders/:orderNo/reconciliation        one order, end to end
//
// Two of these are not plain reads, and stay that way: the report GET rewrites
// the waste audit, and the statement POST marks challans as reported.
// `reconciliation` and `reports` map to challans in the central gate; the
// order-path route is gated as orders, by its first path segment. Handlers are
// the ones that lived in server.js, moved whole.
// ---------------------------------------------------------------------------
//
// Every route here asks the module's operations (./operations.js) at the kernel
// desk; the work is in ./report-work.js. A handler names the operation,
// picks its input out of the request, and sends the result back as the answer
// the app has always had.

const { deskRoutes } = require('../../kernel/desk-kit');

module.exports = function registerChallanReportRoutes(ctx) {
  const { app, desk, requirePermission } = ctx;
  const send = deskRoutes(desk);

  app.get('/api/reconciliation/report', requirePermission('config.read'),
    send('challans.reports.reconciliation', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/reconciliation/conversion-overrides', requirePermission('config.read'),
    send('challans.reports.conversionOverrides', (req) => ({ query: req.query, data: req.body })));

  app.patch('/api/reconciliation/conversion-overrides', requirePermission('config.write'),
    send('challans.reports.setConversionOverrides', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/reconciliation/waste-audit', requirePermission('config.read'),
    send('challans.reports.wasteAudit', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/orders/:orderNo/reconciliation', requirePermission('config.read'),
    send('challans.reports.orderReconciliation', (req) => ({ orderNo: req.params.orderNo, query: req.query, data: req.body })));

  app.post('/api/reports/client-statement', requirePermission('config.read'),
    send('challans.reports.clientStatement', (req) => ({ query: req.query, data: req.body })));
};
