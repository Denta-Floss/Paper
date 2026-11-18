'use strict';

// ---------------------------------------------------------------------------
// The action center over HTTP.
//
//   GET  /api/trash                        what was deleted, most recent first
//   POST /api/trash/restore                bring one back, id and photos included
//
//   GET  /api/delete-requests              requests, newest first (?status=, paged)
//   POST /api/delete-requests              ask for a record to be deleted
//   POST /api/delete-requests/:id/approve  the record goes, the request is marked
//   POST /api/delete-requests/:id/reject   it stays, the request is marked
//   GET  /api/delete-requests/export       every request as CSV
//
//   GET  /api/action-center/issues         references whose target is gone
//
// `trash` and `action-center` are first path segments the central CRUD gate
// maps to action_center; the config.* guards on those routes are the legacy
// no-ops they always were. `delete-requests` is NOT gated as a module: it is in
// the gate's excluded set, so listing, approving, rejecting and exporting are
// guarded by delete_requests.review and the write gate, and asking needs only a
// signed-in session. Handlers are the ones that lived in server.js, moved whole.
// ---------------------------------------------------------------------------

const { deskRoutes } = require('../../kernel/desk-kit');

module.exports = function registerActionCenterRoutes(ctx) {
  const { app, desk, requirePermission, requireAuth } = ctx;
  const send = deskRoutes(desk);

  app.get('/api/trash', requirePermission('config.read'),
    send('action_center.trash.list', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/trash/restore', requirePermission('config.write'),
    send('action_center.trash.restore', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/delete-requests', requirePermission('delete_requests.review'),
    send('action_center.deleteRequests.list', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/delete-requests', requireAuth,
    send('action_center.deleteRequests.create', (req) => ({ query: req.query, data: req.body })));

  app.post('/api/delete-requests/:id/approve', requirePermission('delete_requests.review'),
    send('action_center.deleteRequests.approve', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.post('/api/delete-requests/:id/reject', requirePermission('delete_requests.review'),
    send('action_center.deleteRequests.reject', (req) => ({ id: req.params.id, query: req.query, data: req.body })));

  app.get('/api/delete-requests/export', requirePermission('delete_requests.review'),
    send('action_center.deleteRequests.export', (req) => ({ query: req.query, data: req.body })));

  app.get('/api/action-center/issues', requirePermission('config.read'),
    send('action_center.issues', (req) => ({ query: req.query, data: req.body })));
};
