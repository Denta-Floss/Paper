'use strict';

// ---------------------------------------------------------------------------
// The action center over HTTP.
//
//   GET  /api/trash            what was deleted, most recent first (?tableName=)
//   POST /api/trash/restore    bring one back, original id and photos included
//
// `trash` is a first path segment the central CRUD gate maps to action_center
// (action_center.read / action_center.create); the config.* guards here are the
// legacy no-ops they always were. Handlers are the ones that lived in
// server.js, moved whole.
// ---------------------------------------------------------------------------

module.exports = function registerActionCenterRoutes(ctx) {
  const { app, requirePermission, trash } = ctx;

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
};
