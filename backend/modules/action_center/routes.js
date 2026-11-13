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

module.exports = function registerActionCenterRoutes(ctx) {
  const { app, requireAuth, requirePermission, trash, deleteRequests } = ctx;

  // GET /api/trash — list trashed records (most recent first), optionally filtered by table.
  app.get('/api/trash', requirePermission('config.read'), async (req, res) => {
    try {
      const records = await trash.listTrash(req.query.tableName);
      res.json({ success: true, records, total: records.length, error: null });
    } catch (error) {
      res.status(500).json({ success: false, records: [], total: 0, error: error.message });
    }
  });

  // POST /api/trash/restore
  app.post('/api/trash/restore', requirePermission('config.write'), async (req, res) => {
    try {
      const tableName = String(req.body?.tableName || '');
      const recordId = Number(req.body?.recordId);
      const result = await trash.restore(tableName, recordId);
      if (result.refusal) {
        return res.status(result.refusal.status).json(result.refusal.body);
      }
      res.json({ success: true, restored: result.restored, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // --- delete requests ------------------------------------------------------

  app.get('/api/delete-requests', requirePermission('delete_requests.review'), async (req, res) => {
    try {
      const { requests, total } = await deleteRequests.listRequests(req.query);
      res.json({ success: true, requests, total });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/delete-requests', requireAuth, async (req, res) => {
    try {
      const made = await deleteRequests.createRequest(req.body, req.user.id);
      if (made.refusal) {
        return res.status(made.refusal.status).json(made.refusal.body);
      }
      res.status(201).json({ success: true, request: made.request });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/delete-requests/:id/approve', requirePermission('delete_requests.review'), async (req, res) => {
    try {
      const done = await deleteRequests.approve(Number(req.params.id), {
        note: req.body?.note,
        reviewerId: req.user.id,
        req,
      });
      if (done.refusal) {
        return res.status(done.refusal.status).json(done.refusal.body);
      }
      res.json({ success: true, request: done.request });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/delete-requests/:id/reject', requirePermission('delete_requests.review'), async (req, res) => {
    try {
      const done = await deleteRequests.reject(Number(req.params.id), {
        note: req.body?.note,
        reviewerId: req.user.id,
      });
      if (done.refusal) {
        return res.status(done.refusal.status).json(done.refusal.body);
      }
      res.json({ success: true, request: done.request });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/delete-requests/export', requirePermission('delete_requests.review'), async (req, res) => {
    try {
      const csv = await deleteRequests.exportCsv();
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="delete_requests_export.csv"');
      res.send(csv);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // --- the integrity scan ---------------------------------------------------

  // Scans for broken foreign-key references caused by hard-deletes and returns a
  // structured list of issues the user can resolve.
  app.get('/api/action-center/issues', requirePermission('config.read'), async (req, res) => {
    const { issues, scanErrors } = await deleteRequests.scanIntegrity();
    res.json({ success: true, issues, total: issues.length, scanErrors, error: null });
  });
};
