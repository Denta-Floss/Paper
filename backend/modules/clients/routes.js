'use strict';

// ---------------------------------------------------------------------------
// Clients module — HTTP routes.
//
// All 14 route registrations for clients & sub-contractors territory moved
// VERBATIM from server.js. No logic edits; handler bodies are NOT re-indented.
// Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

function rowToSubContractorDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    gstNumber: row.gst_number,
    address: row.address,
    photoUrl: row.photo_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    clientName: row.client_name,
  };
}

module.exports = function registerClientsModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
    saveClient,
    rowToClientDto,
    getClientsWithUsage,
    getClientUsageCount,
    trackCreate,
    trackUpdate,
    trackDelete,
    trashAndDelete,
    getIo,
  } = ctx;

app.get('/api/clients', requirePermission('config.read'), async (req, res) => {
  try {
    const rows = await getClientsWithUsage();
    res.json({ success: true, clients: rows.map(rowToClientDto), error: null });
  } catch (error) {
    res.status(500).json({ success: false, clients: [], error: error.message });
  }
});

app.get('/api/clients/:id', requirePermission('config.read'), async (req, res) => {
  try {
    const client = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) {
      return res.status(404).json({ success: false, client: null, error: 'Not found' });
    }
    client.usage_count = await getClientUsageCount(client.id);
    res.json({ success: true, client: rowToClientDto(client), error: null });
  } catch (error) {
    res.status(500).json({ success: false, client: null, error: error.message });
  }
});

app.get('/api/sub-contractors', requirePermission('config.read'), async (req, res) => {
  try {
    const rows = await get('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'sub_contractors\'');
    if (!rows) {
      return res.json({ success: true, subContractors: [], error: null });
    }
    const dataRows = await all(`
      SELECT s.*, c.name as client_name 
      FROM sub_contractors s
      LEFT JOIN clients c ON s.client_id = c.id
      ORDER BY s.name ASC
    `);
    res.json({ success: true, subContractors: dataRows.map(rowToSubContractorDto), error: null });
  } catch (error) {
    res.status(500).json({ success: false, subContractors: [], error: error.message });
  }
});

app.get('/api/clients/:clientId/sub-contractors', requirePermission('config.read'), async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const rows = await get('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'sub_contractors\'');
    if (!rows) {
      return res.json({ success: true, subContractors: [], error: null });
    }
    const dataRows = await all('SELECT * FROM sub_contractors WHERE client_id = ? ORDER BY name ASC', [clientId]);
    res.json({ success: true, subContractors: dataRows.map(rowToSubContractorDto), error: null });
  } catch (error) {
    res.status(500).json({ success: false, subContractors: [], error: error.message });
  }
});

app.post('/api/clients/:clientId/sub-contractors', requirePermission('config.write'), async (req, res) => {
  try {
    const clientId = Number(req.params.clientId);
    const { name, phone, email, notes, gstNumber, address, photoUrl } = req.body || {};
    
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    
    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO sub_contractors (client_id, name, phone, email, notes, gst_number, address, photo_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [clientId, String(name).trim(), phone || '', email || '', notes || '', gstNumber || '', address || '', photoUrl || '', now, now]
    );
    
    const row = await get('SELECT * FROM sub_contractors WHERE id = ?', [result.lastID]);
    res.status(201).json({ success: true, subContractor: rowToSubContractorDto(row), error: null });
  } catch (error) {
    res.status(500).json({ success: false, subContractor: null, error: error.message });
  }
});

app.put('/api/sub-contractors/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, phone, email, notes, gstNumber, address, photoUrl } = req.body || {};
    
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    
    const now = new Date().toISOString();
    await run(
      `UPDATE sub_contractors 
       SET name = ?, phone = ?, email = ?, notes = ?, gst_number = ?, address = ?, photo_url = ?, updated_at = ?
       WHERE id = ?`,
      [String(name).trim(), phone || '', email || '', notes || '', gstNumber || '', address || '', photoUrl || '', now, id]
    );
    
    const row = await get('SELECT * FROM sub_contractors WHERE id = ?', [id]);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    res.json({ success: true, subContractor: rowToSubContractorDto(row), error: null });
  } catch (error) {
    res.status(500).json({ success: false, subContractor: null, error: error.message });
  }
});

app.delete('/api/sub-contractors/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await run('DELETE FROM sub_contractors WHERE id = ?', [id]);
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/clients', requirePermission('config.write'), async (req, res) => {
  try {
    const client = await saveClient(req.body || {});
    const clientDto = rowToClientDto(client);
    const io = typeof getIo === 'function' ? getIo() : null;
    if (io) {
      io.emit('client_added', clientDto);
    }
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
    const client = await get('SELECT * FROM clients WHERE id = ?', [id]);
    if (!client) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    const count = await getClientUsageCount(id);
    if (count > 0) {
      const error = new Error('Client is in use');
      error.statusCode = 409;
      throw error;
    }
    await run('UPDATE clients SET is_archived = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.delete('/api/clients/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = await get('SELECT * FROM clients WHERE id = ?', [id]);
    await trashAndDelete('clients', id, req);
    trackDelete('clients', id, before, req);
    const io = typeof getIo === 'function' ? getIo() : null;
    if (io) {
      io.emit('client_deleted', { id });
    }
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/clients/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = await get('SELECT * FROM clients WHERE id = ?', [id]);
    const client = await saveClient({
      ...(req.body || {}),
      id,
    });
    const clientDto = rowToClientDto(client);
    const io = typeof getIo === 'function' ? getIo() : null;
    if (io) {
      io.emit('client_updated', clientDto);
    }
    const after = await get('SELECT * FROM clients WHERE id = ?', [id]);
    trackUpdate('clients', id, before, after, req);
    res.json({ success: true, client: clientDto, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, client: null, error: error.message });
  }
});

app.post('/api/clients/:id/portal-credentials', async (req, res) => {
  try {
    const clientId = req.params.id;
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }
    const hash = password; // Should hash password in production
    
    if (ctx.upsertPortalUser) {
      await ctx.upsertPortalUser(clientId, email, hash);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/clients/:id/portal-catalog', async (req, res) => {
  try {
    const itemIds = ctx.getClientPortalCatalog ? await ctx.getClientPortalCatalog(req.params.id) : [];
    res.json({ success: true, itemIds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/clients/:id/portal-catalog', async (req, res) => {
  try {
    const clientId = req.params.id;
    const { itemIds } = req.body; // Array of item IDs
    
    if (ctx.setClientPortalCatalog) {
      await ctx.setClientPortalCatalog(clientId, itemIds || []);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

};
