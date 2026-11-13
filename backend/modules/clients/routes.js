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
// maps them to the clients module. `sub-contractors` is mapped there too. The
// handlers are the ones that lived in server.js, moved whole.
//
// The company's people (/api/clients/:clientId/contacts) are the sibling file
// modules/parties/contacts.js, mounted elsewhere. The B2B portal that hangs off
// a client is portal-routes.js.
// ---------------------------------------------------------------------------

module.exports = function registerClientRoutes(ctx) {
  const {
    app,
    all,
    get,
    requirePermission,
    trackCreate,
    trackUpdate,
    trackDelete,
    trashAndDelete,
    partyDeleteBlockers,
    partyContacts,
    getIo,
    clients,
  } = ctx;

  const emit = (event, payload) => {
    const io = getIo();
    if (io) {
      io.emit(event, payload);
    }
  };

  app.get('/api/clients', requirePermission('config.read'), async (req, res) => {
    try {
      const rows = await partyContacts.attachClientContacts({ all }, await clients.getClientsWithUsage());
      res.json({ success: true, clients: rows.map(clients.rowToClientDto), error: null });
    } catch (error) {
      res.status(500).json({ success: false, clients: [], error: error.message });
    }
  });

  app.get('/api/clients/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const row = await clients.getClientRowById(req.params.id);
      if (!row) {
        return res.status(404).json({ success: false, client: null, error: 'Not found' });
      }
      await partyContacts.attachClientContacts({ all }, row);
      res.json({ success: true, client: clients.rowToClientDto(row), error: null });
    } catch (error) {
      res.status(500).json({ success: false, client: null, error: error.message });
    }
  });

  app.post('/api/clients', requirePermission('config.write'), async (req, res) => {
    try {
      const client = await clients.saveClient(req.body || {});
      await partyContacts.attachClientContacts({ all }, client);
      const clientDto = clients.rowToClientDto(client);
      emit('client_added', clientDto);
      trackCreate('clients', client.id, client, req);
      res.status(201).json({ success: true, client: clientDto, error: null });
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
      const result = await clients.archiveClient(id);
      if (result.notFound) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }
      if (result.already) {
        return res.json({ success: true, client: clients.rowToClientDto(result.row), error: null });
      }
      const clientDto = clients.rowToClientDto(result.row);
      // Every other client write broadcasts; this one never did, so an archive
      // stayed invisible to every other session until it reloaded.
      emit('client_updated', clientDto);
      trackUpdate('clients', id, result.before, result.row, req);
      // The updated row, so the caller knows the new state without refetching
      // the whole list.
      res.json({ success: true, client: clientDto, error: null });
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
      const result = await clients.unarchiveClient(id);
      if (result.notFound) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }
      const clientDto = clients.rowToClientDto(result.row);
      emit('client_updated', clientDto);
      trackUpdate('clients', id, result.before, result.row, req);
      res.json({ success: true, client: clientDto, error: null });
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
      const before = await get('SELECT * FROM clients WHERE id = ?', [id]);
      const blockers = await partyDeleteBlockers('clients', id);
      if (blockers.length > 0) {
        return res.status(409).json({
          success: false,
          code: 'client_in_use',
          error: `"${before?.name || 'This client'}" is still named on ${blockers.join(' and ')}. `
            + 'Archive it instead, or move those first.',
        });
      }
      await trashAndDelete('clients', id, req);
      trackDelete('clients', id, before, req);
      emit('client_deleted', { id });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/clients/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const before = await get('SELECT * FROM clients WHERE id = ?', [id]);
      const client = await clients.saveClient({
        ...(req.body || {}),
        id,
      });
      await partyContacts.attachClientContacts({ all }, client);
      const clientDto = clients.rowToClientDto(client);
      emit('client_updated', clientDto);
      const after = await get('SELECT * FROM clients WHERE id = ?', [id]);
      trackUpdate('clients', id, before, after, req);
      res.json({ success: true, client: clientDto, error: null });
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
      res.json({ success: true, subContractors: await clients.listSubContractors(), error: null });
    } catch (error) {
      res.status(500).json({ success: false, subContractors: [], error: error.message });
    }
  });

  app.get('/api/clients/:clientId/sub-contractors', requirePermission('config.read'), async (req, res) => {
    try {
      const clientId = Number(req.params.clientId);
      res.json({
        success: true,
        subContractors: await clients.listSubContractorsForClient(clientId),
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, subContractors: [], error: error.message });
    }
  });

  app.post('/api/clients/:clientId/sub-contractors', requirePermission('config.write'), async (req, res) => {
    try {
      const clientId = Number(req.params.clientId);
      const made = await clients.createSubContractor(clientId, req.body);
      if (made.refusal) {
        return res.status(made.refusal.status).json(made.refusal.body);
      }
      trackCreate('sub_contractors', made.id, made.row, req);
      res.status(201).json({ success: true, subContractor: made.dto, error: null });
    } catch (error) {
      res.status(500).json({ success: false, subContractor: null, error: error.message });
    }
  });

  app.put('/api/sub-contractors/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const saved = await clients.updateSubContractor(id, req.body);
      if (saved.refusal) {
        return res.status(saved.refusal.status).json(saved.refusal.body);
      }
      trackUpdate('sub_contractors', id, saved.existing, saved.row, req);
      res.json({ success: true, subContractor: saved.dto, error: null });
    } catch (error) {
      res.status(500).json({ success: false, subContractor: null, error: error.message });
    }
  });

  app.delete('/api/sub-contractors/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const before = await clients.deleteSubContractor(id);
      trackDelete('sub_contractors', id, before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
};
