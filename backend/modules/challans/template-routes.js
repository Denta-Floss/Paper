'use strict';

// ---------------------------------------------------------------------------
// Challan templates over HTTP.
//
//   GET    /api/challan-templates                        the templates
//   GET    /api/challan-templates/scans                  uploaded form scans
//   GET    /api/challan-templates/:id                    one
//   POST   /api/challan-templates                        create
//   PATCH  /api/challan-templates/:id                    change
//   DELETE /api/challan-templates/:id                    remove
//   POST   /api/challan-templates/upload-intent          scan upload, start
//   POST   /api/challan-templates/upload-complete        scan upload, finish
//   POST   /api/challan-templates/stamp-upload-intent    stamp upload, start
//   POST   /api/challan-templates/stamp-upload-complete  stamp upload, finish
//   POST   /api/challan-templates/test-print             a sample PDF
//   GET    /api/templates/:id/test-print                 a sample PDF, by id
//   GET    /api/challans/:id/print-template-preview      a challan on its template
//
//   GET    /api/challan-templates/test-print             a sample PDF (same handler)
//
// ORDER MATTERS in this file: /scans and both /test-print routes are registered
// before /:id, or they are read as a template id. The route-surface test sorts
// its list and cannot see an order change; challans-routes.test.js pins /scans
// and GET /test-print answering for that reason.
//
// Handlers are the ones that lived in server.js, moved whole.
// ---------------------------------------------------------------------------
//
// Every route here asks the module's operations (./operations.js) at the kernel
// desk; the work is in ./template-work.js. A handler names the operation,
// picks its input out of the request, and sends the result back as the answer
// the app has always had.

const { deskRoutes } = require('../../kernel/desk-kit');

module.exports = function registerChallanTemplateRoutes(ctx) {
  const { app, desk, requirePermission } = ctx;
  const send = deskRoutes(desk);

  app.get('/api/challan-templates', requirePermission('config.read'),
    send('challans.templates.list', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/challan-templates/scans', requirePermission('config.read'),
    send('challans.templates.scans', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/challan-templates/test-print', requirePermission('config.read'),
    send('challans.templates.testPrint', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/challan-templates/:id', requirePermission('config.read'),
    send('challans.templates.get', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/challan-templates', requirePermission('config.write'),
    send('challans.templates.create', (req) => ({ query: req.query, data: req.body })));

  app.patch('/api/challan-templates/:id', requirePermission('config.write'),
    send('challans.templates.update', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.delete('/api/challan-templates/:id', requirePermission('config.write'),
    send('challans.templates.delete', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/challan-templates/upload-intent', requirePermission('config.write'),
    send('challans.templates.uploadIntent', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/challan-templates/upload-complete', requirePermission('config.write'),
    send('challans.templates.uploadComplete', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/challan-templates/stamp-upload-intent', requirePermission('config.write'),
    send('challans.templates.stampUploadIntent', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/challan-templates/stamp-upload-complete', requirePermission('config.write'),
    send('challans.templates.stampUploadComplete', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/challan-templates/test-print', requirePermission('config.read'),
    send('challans.templates.testPrintPosted', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/templates/:id/test-print', requirePermission('config.read'),
    send('challans.templates.testPrintFor', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/challans/:id/print-template-preview', requirePermission('config.read'),
    send('challans.printPreview', (req) => ({ id: req.params.id, query: req.query, data: req.body })));
};
