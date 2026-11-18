'use strict';

// ---------------------------------------------------------------------------
// The client master over HTTP, and its sub-contractors.
//
//   GET    /api/clients                              everyone, archived last
//   GET    /api/clients/:id                          one, with its people
//   POST   /api/clients                              add one
//   PATCH  /api/clients/:id                          change one (absent = keep)
//   PATCH  /api/clients/:id/archive                  retire one nothing names
//   PATCH  /api/clients/:id/unarchive                bring it back
//   DELETE /api/clients/:id                          remove one nothing names
//
//   GET    /api/sub-contractors                      all, with their client
//   GET    /api/clients/:clientId/sub-contractors    one client's
//   POST   /api/clients/:clientId/sub-contractors    add one
//   PUT    /api/sub-contractors/:id                  change one (absent = keep)
//   DELETE /api/sub-contractors/:id                  remove one
//
// `clients` is the first path segment of most of these, so the central CRUD gate
// maps them to the clients module. `sub-contractors` is mapped there too.
//
// The work is the module's operations (./operations.js), asked for at the
// kernel desk. A handler translates a request into an operation's input and its
// result into the answer the app has always had, broadcasts the change, and
// writes the Track entry, which needs the request.
//
// The company's people (/api/clients/:clientId/contacts) are the sibling file
// modules/parties/contacts.js, mounted elsewhere. The B2B portal that hangs off
// a client is portal-routes.js.
// ---------------------------------------------------------------------------

const { httpKit } = require('../../kernel/desk-kit');

module.exports = function registerClientRoutes(ctx) {
  const { app, desk, requirePermission, trackCreate, trackUpdate, trackDelete, getIo } = ctx;
  const { ask, refuse } = httpKit(desk);

  const emit = (event, payload) => {
    const io = getIo();
    if (io) {
      io.emit(event, payload);
    }
  };

  /// A client write's refusal. Archive and unarchive say `code` even when there
  /// is none; a client that is not there is answered with the error alone.
  const refuseClient = (res, result, { withCode = false } = {}) => {
    if (result.notFound) {
      return res.status(404).json({ success: false, error: result.error });
    }
    return res.status(result.status || 400).json({
      success: false,
      client: null,
      ...(withCode ? { code: result.code || null } : {}),
      error: result.error,
    });
  };

  app.get('/api/clients', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'clients.list');
      if (!result.ok) {
        return res.status(result.status || 400).json({ success: false, clients: [], error: result.error });
      }
      res.json({ success: true, clients: result.clients, error: null });
    } catch (error) {
      res.status(500).json({ success: false, clients: [], error: error.message });
    }
  });

  app.get('/api/clients/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'clients.get', { id: req.params.id });
      if (!result.ok) return refuseClient(res, result);
      res.json({ success: true, client: result.client, error: null });
    } catch (error) {
      res.status(500).json({ success: false, client: null, error: error.message });
    }
  });

  app.post('/api/clients', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'clients.create', { ...(req.body || {}) });
      if (!result.ok) return refuseClient(res, result);
      emit('client_added', result.client);
      trackCreate('clients', result.row.id, result.row, req);
      res.status(201).json({ success: true, client: result.client, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        client: null,
        error: error.message,
      });
    }
  });

  app.patch('/api/clients/:id/archive', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'clients.archive', { id });
      if (!result.ok) return refuseClient(res, result, { withCode: true });
      if (!result.already) {
        // Every other client write broadcasts; this one never did, so an archive
        // stayed invisible to every other session until it reloaded.
        emit('client_updated', result.client);
        trackUpdate('clients', id, result.before, result.after, req);
      }
      // The updated row, so the caller knows the new state without refetching
      // the whole list.
      res.json({ success: true, client: result.client, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        client: null,
        code: error.code || null,
        error: error.message,
      });
    }
  });

  // Archive was a one-way door: there was no route back, so a client archived by
  // mistake could only be fixed in the database.
  app.patch('/api/clients/:id/unarchive', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'clients.unarchive', { id });
      if (!result.ok) return refuseClient(res, result, { withCode: true });
      emit('client_updated', result.client);
      trackUpdate('clients', id, result.before, result.after, req);
      res.json({ success: true, client: result.client, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        client: null,
        code: error.code || null,
        error: error.message,
      });
    }
  });

  app.delete('/api/clients/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'clients.delete', { id });
      if (!result.ok) {
        return res.status(result.status || 400).json({
          success: false,
          ...(result.code ? { code: result.code } : {}),
          error: result.error,
        });
      }
      trackDelete('clients', id, result.before, req);
      emit('client_deleted', { id });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/clients/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'clients.update', { ...(req.body || {}), id });
      if (!result.ok) return refuseClient(res, result);
      emit('client_updated', result.client);
      trackUpdate('clients', id, result.before, result.after, req);
      res.json({ success: true, client: result.client, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        client: null,
        error: error.message,
      });
    }
  });

  // --- SUB-CONTRACTORS ENDPOINTS ---

  app.get('/api/sub-contractors', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'clients.subContractors.list');
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, subContractors: result.subContractors, error: null });
    } catch (error) {
      res.status(500).json({ success: false, subContractors: [], error: error.message });
    }
  });

  app.get('/api/clients/:clientId/sub-contractors', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'clients.subContractors.listForClient', {
        clientId: Number(req.params.clientId),
      });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, subContractors: result.subContractors, error: null });
    } catch (error) {
      res.status(500).json({ success: false, subContractors: [], error: error.message });
    }
  });

  app.post('/api/clients/:clientId/sub-contractors', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'clients.subContractors.create', {
        ...(req.body || {}),
        clientId: Number(req.params.clientId),
      });
      if (!result.ok) return refuse(res, result);
      trackCreate('sub_contractors', result.id, result.row, req);
      res.status(201).json({ success: true, subContractor: result.subContractor, error: null });
    } catch (error) {
      res.status(500).json({ success: false, subContractor: null, error: error.message });
    }
  });

  app.put('/api/sub-contractors/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'clients.subContractors.update', { ...(req.body || {}), id });
      if (!result.ok) return refuse(res, result);
      trackUpdate('sub_contractors', id, result.before, result.after, req);
      res.json({ success: true, subContractor: result.subContractor, error: null });
    } catch (error) {
      res.status(500).json({ success: false, subContractor: null, error: error.message });
    }
  });

  app.delete('/api/sub-contractors/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'clients.subContractors.delete', { id });
      if (!result.ok) return refuse(res, result);
      trackDelete('sub_contractors', id, result.before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
};
