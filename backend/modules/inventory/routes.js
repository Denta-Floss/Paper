'use strict';

// ---------------------------------------------------------------------------
// Inventory over HTTP: the sets, the materials, and the movements.
//
//   GET    /api/inventory/sets        every set, with its lines and its group
//   POST   /api/inventory/sets        define one
//   PATCH  /api/inventory/sets/:id    change one (a full replace of its lines;
//                                     send expectedVersion to be refused if it
//                                     moved on, code set_changed)
//   DELETE /api/inventory/sets/:id    remove one and its links
//
//   GET    /api/materials                       every material
//   GET    /api/materials/:barcode              one, with its group configuration
//   GET    /api/materials/:barcode/detail       the control-tower read model
//   GET    /api/materials/:barcode/activity     its per-barcode feed
//   POST   /api/materials/parent                a parent and its children
//   POST   /api/materials/:barcode/child        one more child
//   PATCH  /api/materials/:barcode              edit
//   PATCH  /api/materials/:barcode/group-config governance
//   PATCH  /api/materials/:barcode/link-group   inherit from a group
//   PATCH  /api/materials/:barcode/link-item    inherit from an item and variation
//   PATCH  /api/materials/:barcode/unlink       stop inheriting
//   PATCH  /api/materials/:barcode/scan         count a scan
//   PATCH  /api/materials/:barcode/scan/reset   clear the trace
//   DELETE /api/materials/:barcode              remove it (a parent takes its children)
//   POST   /api/inventory/movements             receive, issue, transfer
//   GET    /api/inventory/health                the summary tiles
//
// `inventory` and `materials` are first path segments, so the central CRUD gate
// maps these to the inventory module. Handlers are the ones that lived in
// server.js, moved whole.
//
// NOT here: GET /api/inventory/stock (next step), the universal barcode resolver
// and /api/scan, the search routes. See modules/inventory/service.js.
// ---------------------------------------------------------------------------

module.exports = function registerInventoryRoutes(ctx) {
  const {
    app,
    get,
    run,
    requirePermission,
    cacheMasterData,
    trackCreate,
    trackUpdate,
    trackDelete,
    currentActor,
    inventory,
    // Still defined in server.js: the barcode lookup items and inventory share.
    getMaterialRowByBarcode,
    all,
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

  app.get('/api/materials', requirePermission('inventory.read'), cacheMasterData, async (req, res) => {
    try {
      const rows = await all(
        'SELECT * FROM materials ORDER BY kind ASC, created_at DESC, barcode ASC',
      );
      res.json({ success: true, materials: rows.map(inventory.rowToMaterialDto) });
    } catch (error) {
      res.status(500).json({ success: false, materials: [], error: error.message });
    }
  });

  app.get('/api/inventory/health', requirePermission('inventory.read'), async (_req, res) => {
    try {
      const health = await inventory.getInventoryHealthSummary();
      res.json({ success: true, health, error: null });
    } catch (error) {
      res.status(500).json({
        success: false,
        health: null,
        error: error.message,
      });
    }
  });

  app.get('/api/materials/:barcode', requirePermission('inventory.read'), async (req, res) => {
    try {
      const row = await getMaterialRowByBarcode(req.params.barcode);
      if (!row) {
        res.status(404).json({
          success: false,
          material: null,
          error: `No material found for barcode ${req.params.barcode}.`,
        });
        return;
      }
      const groupConfiguration = await inventory.getMaterialGroupGovernance(row.id);
      res.json({
        success: true,
        material: inventory.rowToMaterialDto(row),
        groupConfiguration,
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
    }
  });

  app.get('/api/materials/:barcode/detail', requirePermission('inventory.read'), async (req, res) => {
    try {
      const detail = await inventory.getMaterialControlTowerDetail(req.params.barcode);
      if (!detail) {
        res.status(404).json({
          success: false,
          material: null,
          error: `No material found for barcode ${req.params.barcode}.`,
        });
        return;
      }
      const row = await getMaterialRowByBarcode(req.params.barcode);
      const groupConfiguration = row
        ? await inventory.getMaterialGroupGovernance(row.id)
        : { selectedItemIds: [], selectedItems: [], propertyDrafts: [] };
      res.json({
        success: true,
        ...detail,
        groupConfiguration,
        error: null,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        material: null,
        error: error.message,
      });
    }
  });

  app.post('/api/materials/parent', requirePermission('inventory.create'), async (req, res) => {
    try {
      const payload = { ...(req.body || {}), actor: currentActor(req) };
      if (!payload.name || !payload.type || payload.numberOfChildren == null) {
        res.status(400).json({
          success: false,
          material: null,
          error: 'name, type, and numberOfChildren are required.',
        });
        return;
      }

      const material = await inventory.createParentWithChildren(payload);
      const createdRow = await getMaterialRowByBarcode(material.barcode);
      const groupConfiguration = createdRow
        ? await inventory.getMaterialGroupGovernance(createdRow.id)
        : { selectedItemIds: [], selectedItems: [], propertyDrafts: [] };
      // Materials also keep their own `material_activity` feed, read by
      // GET /api/materials/:barcode/activity. That one is per-barcode stock
      // movement; this is who-changed-what, which is the axis a sitting groups
      // by — so both are wanted, and neither replaces the other.
      if (createdRow) trackCreate('materials', createdRow.id, createdRow, req);
      res.status(201).json({ success: true, material, groupConfiguration, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
    }
  });

  app.post('/api/materials/:barcode/child', requirePermission('inventory.create'), async (req, res) => {
    try {
      const payload = { ...(req.body || {}), actor: currentActor(req) };
      if (!String(payload.name || '').trim()) {
        res.status(400).json({
          success: false,
          material: null,
          error: 'name is required.',
        });
        return;
      }
      const material = await inventory.createChildMaterial(req.params.barcode, payload);
      trackCreate('materials', material.id, material, req);
      res.status(201).json({ success: true, material: inventory.rowToMaterialDto(material), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
    }
  });

  app.patch('/api/materials/:barcode', requirePermission('inventory.update'), async (req, res) => {
    try {
      const payload = { ...(req.body || {}), actor: currentActor(req) };
      if (!payload.name || !payload.type) {
        res.status(400).json({
          success: false,
          material: null,
          error: 'name and type are required.',
        });
        return;
      }
      const before = await getMaterialRowByBarcode(req.params.barcode);
      const material = await inventory.updateMaterialRecord(req.params.barcode, payload);
      const groupConfiguration = await inventory.getMaterialGroupGovernance(material.id);
      trackUpdate('materials', material.id, before, material, req);
      res.json({
        success: true,
        material: inventory.rowToMaterialDto(material),
        groupConfiguration,
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, material: null, error: error.message });
    }
  });

  app.patch('/api/materials/:barcode/group-config', requirePermission('inventory.update'), async (req, res) => {
    try {
      const payload = req.body || {};
      const material = await inventory.updateMaterialGroupConfiguration(req.params.barcode, payload);
      const groupConfiguration = await inventory.getMaterialGroupGovernance(material.id);
      res.json({
        success: true,
        material: inventory.rowToMaterialDto(material),
        groupConfiguration,
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, material: null, error: error.message });
    }
  });

  app.delete('/api/materials/:barcode', requirePermission('inventory.delete'), async (req, res) => {
    try {
      // The barcode is the handle here, not the id, so the row has to be read
      // before it goes to have anything to log against.
      const before = await getMaterialRowByBarcode(req.params.barcode);
      await inventory.deleteMaterialRecord(req.params.barcode);
      if (before) trackDelete('materials', before.id, before, req);
      res.json({ success: true, material: null, error: null });
    } catch (error) {
      res.status(500).json({ success: false, material: null, error: error.message });
    }
  });

  app.patch('/api/materials/:barcode/link-group', requirePermission('inventory.update'), async (req, res) => {
    try {
      const material = await inventory.linkMaterialRecordToGroup(
        req.params.barcode,
        req.body?.groupId,
      );
      res.json({ success: true, material: inventory.rowToMaterialDto(material), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
    }
  });

  app.patch('/api/materials/:barcode/link-item', requirePermission('inventory.update'), async (req, res) => {
    try {
      const material = await inventory.linkMaterialRecordToItem(
        req.params.barcode,
        req.body?.itemId,
        req.body?.variationLeafNodeId,
      );
      res.json({ success: true, material: inventory.rowToMaterialDto(material), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
    }
  });

  app.patch('/api/materials/:barcode/unlink', requirePermission('inventory.update'), async (req, res) => {
    try {
      const material = await inventory.unlinkMaterialRecord(req.params.barcode);
      res.json({ success: true, material: inventory.rowToMaterialDto(material), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
    }
  });

  app.patch('/api/materials/:barcode/scan', requirePermission('inventory.update'), async (req, res) => {
    try {
      const materialRow = await inventory.incrementMaterialScanCount(req.params.barcode);
      if (!materialRow) {
        res.status(404).json({
          success: false,
          material: null,
          error: `No material found for barcode ${req.params.barcode}.`,
        });
        return;
      }
      res.json({
        success: true,
        material: inventory.rowToMaterialDto(materialRow),
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, material: null, error: error.message });
    }
  });

  app.patch('/api/materials/:barcode/scan/reset', requirePermission('inventory.update'), async (req, res) => {
    try {
      const row = await getMaterialRowByBarcode(req.params.barcode);
      if (!row) {
        res.status(404).json({
          success: false,
          material: null,
          error: `No material found for barcode ${req.params.barcode}.`,
        });
        return;
      }
      await run(
        'UPDATE materials SET scan_count = 0, updated_at = ?, last_scanned_at = NULL WHERE id = ?',
        [new Date().toISOString(), row.id],
      );
      await run('DELETE FROM scan_history WHERE barcode = ?', [row.barcode]);
      await inventory.logMaterialActivity({
        barcode: row.barcode,
        type: 'scanReset',
        label: 'Trace reset',
        description: 'Scan history was cleared for this material.',
        actor: row.created_by || 'Demo Admin',
      });
      const updatedRow = await get('SELECT * FROM materials WHERE id = ?', [row.id]);
      res.json({
        success: true,
        material: inventory.rowToMaterialDto(updatedRow),
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, material: null, error: error.message });
    }
  });

  app.post('/api/inventory/movements', requirePermission('inventory.update'), async (req, res) => {
    try {
      const detail = await inventory.applyInventoryMovement({
        ...(req.body || {}),
        actor: currentActor(req),
      });
      res.status(201).json({
        success: true,
        ...detail,
        error: null,
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        material: null,
        error: error.message,
      });
    }
  });

  app.get('/api/materials/:barcode/activity', requirePermission('inventory.read'), async (req, res) => {
    try {
      const events = await inventory.getMaterialActivity(req.params.barcode);
      res.json({
        success: true,
        events: events.map(inventory.rowToMaterialActivityDto),
        error: null,
      });
    } catch (error) {
      res.status(500).json({ success: false, events: [], error: error.message });
    }
  });
};
