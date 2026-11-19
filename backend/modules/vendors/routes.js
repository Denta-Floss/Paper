'use strict';

// ---------------------------------------------------------------------------
// The vendor master over HTTP.
//
//   GET    /api/vendors                        everyone, archived last
//   GET    /api/vendors/:id                    one, with how many challans name it
//   GET    /api/vendors/:id/purchase-history   what they have delivered to us
//   POST   /api/vendors                        add one
//   PATCH  /api/vendors/:id                    change one
//   DELETE /api/vendors/:id                    remove one nothing names
//
// `vendors` is the first path segment, so the central CRUD gate maps every
// route here to the vendors module.
//
// The work is the module's operations (./operations.js), asked for at the
// kernel desk. A handler translates a request into an operation's input and its
// result into the answer the app has always had, broadcasts the change, and
// writes the Track entry, which needs the request.
// ---------------------------------------------------------------------------

const { httpKit } = require('../../kernel/desk-kit');

module.exports = function registerVendorRoutes(ctx) {
  const { app, desk, requirePermission, trackCreate, trackUpdate, trackDelete } = ctx;
  const { ask } = httpKit(desk);

  app.get('/api/vendors', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'vendors.list');
      if (!result.ok) {
        return res.status(result.status || 400).json({ success: false, vendors: [], error: result.error });
      }
      res.json({ success: true, vendors: result.vendors, error: null });
    } catch (error) {
      res.status(500).json({ success: false, vendors: [], error: error.message });
    }
  });

  app.get('/api/vendors/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'vendors.get', { id: req.params.id });
      if (!result.ok) {
        return res.status(result.status || 400).json({ success: false, vendor: null, error: result.error });
      }
      res.json({ success: true, vendor: result.vendor, error: null });
    } catch (error) {
      res.status(500).json({ success: false, vendor: null, error: error.message });
    }
  });

  app.get('/api/vendors/:id/purchase-history', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'vendors.purchaseHistory', { id: Number(req.params.id) });
      if (!result.ok) {
        return res.status(result.status || 400).json({ success: false, history: [], error: result.error });
      }
      res.json({ success: true, history: result.history, error: null });
    } catch (error) {
      res.status(500).json({ success: false, history: [], error: error.message });
    }
  });

  app.post('/api/vendors', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'vendors.create', { ...(req.body || {}) });
      if (!result.ok) {
        return res.status(result.status || 400).json({ success: false, vendor: null, error: result.error });
      }
      trackCreate('vendors', result.row.id, result.row, req);
      res.status(201).json({ success: true, vendor: result.vendor, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, vendor: null, error: error.message });
    }
  });

  app.delete('/api/vendors/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'vendors.delete', { id });
      if (!result.ok) {
        return res.status(result.status || 400).json({
          success: false,
          ...(result.code ? { code: result.code } : {}),
          error: result.error,
        });
      }
      trackDelete('vendors', id, result.before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/vendors/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'vendors.update', { ...(req.body || {}), id });
      if (!result.ok) {
        return res.status(result.status || 400).json({ success: false, vendor: null, error: result.error });
      }
      trackUpdate('vendors', id, result.before, result.after, req);
      res.json({ success: true, vendor: result.vendor, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, vendor: null, error: error.message });
    }
  });
};
