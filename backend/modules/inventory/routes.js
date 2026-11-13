'use strict';

// ---------------------------------------------------------------------------
// Inventory over HTTP. Today: the sets.
//
//   GET    /api/inventory/sets        every set, with its lines and its group
//   POST   /api/inventory/sets        define one
//   PATCH  /api/inventory/sets/:id    change one (a full replace of its lines;
//                                     send expectedVersion to be refused if it
//                                     moved on, code set_changed)
//   DELETE /api/inventory/sets/:id    remove one and its links
//
// `inventory` is the first path segment, so the central CRUD gate maps these to
// the inventory module. Handlers are the ones that lived in server.js, moved
// whole.
// ---------------------------------------------------------------------------

module.exports = function registerInventoryRoutes(ctx) {
  const {
    app,
    get,
    requirePermission,
    trackCreate,
    trackUpdate,
    trackDelete,
    inventory,
  } = ctx;

  app.get('/api/inventory/sets', requirePermission('inventory.read'), async (_req, res) => {
    try {
      const sets = await inventory.getInventorySets();
      res.json({ success: true, sets, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        sets: [],
        error: error.message,
        code: error.code ?? null,
      });
    }
  });

  app.post('/api/inventory/sets', requirePermission('inventory.create'), async (req, res) => {
    try {
      const set = await inventory.saveInventorySet(req.body || {});
      trackCreate('inventory_sets', set.id, set, req);
      res.status(201).json({ success: true, set, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        set: null,
        error: error.message,
        // Machine-readable, so a caller can tell "this set moved on" from any
        // other refusal without matching on prose.
        code: error.code ?? null,
      });
    }
  });

  app.patch('/api/inventory/sets/:id', requirePermission('inventory.update'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      // saveInventorySet answers with the DTO, not the row it replaced, so the
      // before state has to be read here or the diff would be empty and
      // trackUpdate would log nothing at all.
      const before = await get('SELECT * FROM inventory_sets WHERE id = ?', [id]);
      const set = await inventory.saveInventorySet({
        ...(req.body || {}),
        id,
      });
      const after = await get('SELECT * FROM inventory_sets WHERE id = ?', [id]);
      trackUpdate('inventory_sets', id, before, after, req);
      res.json({ success: true, set, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        set: null,
        error: error.message,
        // Machine-readable, so a caller can tell "this set moved on" from any
        // other refusal without matching on prose.
        code: error.code ?? null,
      });
    }
  });

  app.delete('/api/inventory/sets/:id', requirePermission('inventory.delete'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      // Deleting a set is permanent — it purges links and drops the row with no
      // trashAndDelete — so this log line is the only surviving record of it.
      const before = await get('SELECT * FROM inventory_sets WHERE id = ?', [id]);
      await inventory.deleteInventorySet(id);
      trackDelete('inventory_sets', id, before, req);
      res.json({ success: true, set: null, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        set: null,
        error: error.message,
        // Machine-readable, so a caller can tell "this set moved on" from any
        // other refusal without matching on prose.
        code: error.code ?? null,
      });
    }
  });
};
