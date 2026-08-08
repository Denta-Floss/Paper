'use strict';

// ---------------------------------------------------------------------------
// Inventory module — HTTP routes.
//
// All 21 route registrations for inventory territory (inventory, materials,
// material-groups) moved VERBATIM from server.js. No logic edits; handler bodies
// are NOT re-indented. Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerInventoryModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
    getInventoryStockList,
    rowToMaterialDto,
    getInventoryHealthSummary,
    getMaterialRowByBarcode,
    getMaterialGroupGovernance,
    getMaterialControlTowerDetail,
    getInventorySets,
    saveInventorySet,
    deleteInventorySet,
    createParentWithChildren,
    createChildMaterial,
    updateMaterialRecord,
    updateMaterialGroupConfiguration,
    deleteMaterialRecord,
    linkMaterialRecordToGroup,
    linkMaterialRecordToItem,
    unlinkMaterialRecord,
    incrementMaterialScanCount,
    resetMaterialScanCount,
    applyInventoryMovement,
    getMaterialActivity,
    rowToMaterialActivityDto,
    currentActor,
  } = ctx;

app.get('/api/inventory/stock', requirePermission('inventory.read'), async (req, res) => {
  try {
    const stock = await getInventoryStockList();
    res.json({ success: true, stock, error: null });
  } catch (error) {
    res.status(500).json({ success: false, stock: [], error: error.message });
  }
});

app.get('/api/materials', requirePermission('inventory.read'), async (req, res) => {
  try {
    const rows = await all(
      'SELECT * FROM materials ORDER BY kind ASC, created_at DESC, barcode ASC',
    );
    res.json({ success: true, materials: rows.map(rowToMaterialDto) });
  } catch (error) {
    res.status(500).json({ success: false, materials: [], error: error.message });
  }
});

app.get('/api/inventory/health', requirePermission('inventory.read'), async (_req, res) => {
  try {
    const health = await getInventoryHealthSummary();
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
    const groupConfiguration = await getMaterialGroupGovernance(row.id);
    res.json({
      success: true,
      material: rowToMaterialDto(row),
      groupConfiguration,
      error: null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
  }
});

app.get('/api/materials/:barcode/detail', requirePermission('inventory.read'), async (req, res) => {
  try {
    const detail = await getMaterialControlTowerDetail(req.params.barcode);
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
      ? await getMaterialGroupGovernance(row.id)
      : { selectedItemIds: [], selectedItems: [], propertyDrafts: [] };
    res.json({
      success: true,
      material: detail,
      groupConfiguration,
      error: null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
  }
});

app.get('/api/inventory/sets', requirePermission('inventory.read'), async (_req, res) => {
  try {
    const sets = await getInventorySets();
    res.json({ success: true, sets, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      sets: [],
      error: error.message,
    });
  }
});

app.post('/api/inventory/sets', requirePermission('inventory.create'), async (req, res) => {
  try {
    const set = await saveInventorySet(req.body || {});
    res.status(201).json({ success: true, set, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      set: null,
      error: error.message,
    });
  }
});

app.patch('/api/inventory/sets/:id', requirePermission('inventory.update'), async (req, res) => {
  try {
    const set = await saveInventorySet({
      ...(req.body || {}),
      id: Number(req.params.id),
    });
    res.json({ success: true, set, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      set: null,
      error: error.message,
    });
  }
});

app.delete('/api/inventory/sets/:id', requirePermission('inventory.delete'), async (req, res) => {
  try {
    await deleteInventorySet(Number(req.params.id));
    res.json({ success: true, set: null, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      set: null,
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

    const material = await createParentWithChildren(payload);
    const createdRow = await getMaterialRowByBarcode(material.barcode);
    const groupConfiguration = createdRow
      ? await getMaterialGroupGovernance(createdRow.id)
      : { selectedItemIds: [], selectedItems: [], propertyDrafts: [] };
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
    const material = await createChildMaterial(req.params.barcode, payload);
    res.status(201).json({ success: true, material: rowToMaterialDto(material), error: null });
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
    const material = await updateMaterialRecord(req.params.barcode, payload);
    const groupConfiguration = await getMaterialGroupGovernance(material.id);
    res.json({
      success: true,
      material: rowToMaterialDto(material),
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
    const material = await updateMaterialGroupConfiguration(req.params.barcode, payload);
    const groupConfiguration = await getMaterialGroupGovernance(material.id);
    res.json({
      success: true,
      material: rowToMaterialDto(material),
      groupConfiguration,
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, material: null, error: error.message });
  }
});

app.delete('/api/materials/:barcode', requirePermission('inventory.delete'), async (req, res) => {
  try {
    await deleteMaterialRecord(req.params.barcode);
    res.json({ success: true, material: null, error: null });
  } catch (error) {
    res.status(500).json({ success: false, material: null, error: error.message });
  }
});

app.patch('/api/materials/:barcode/link-group', requirePermission('inventory.update'), async (req, res) => {
  try {
    const material = await linkMaterialRecordToGroup(
      req.params.barcode,
      req.body?.groupId,
    );
    res.json({ success: true, material: rowToMaterialDto(material), error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
  }
});

app.patch('/api/materials/:barcode/link-item', requirePermission('inventory.update'), async (req, res) => {
  try {
    const material = await linkMaterialRecordToItem(
      req.params.barcode,
      req.body?.itemId,
      req.body?.variationLeafNodeId,
    );
    res.json({ success: true, material: rowToMaterialDto(material), error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
  }
});

app.patch('/api/materials/:barcode/unlink', requirePermission('inventory.update'), async (req, res) => {
  try {
    const material = await unlinkMaterialRecord(req.params.barcode);
    res.json({ success: true, material: rowToMaterialDto(material), error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, material: null, error: error.message });
  }
});

app.patch('/api/materials/:barcode/scan', requirePermission('inventory.update'), async (req, res) => {
  try {
    const materialRow = await incrementMaterialScanCount(req.params.barcode);
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
      material: rowToMaterialDto(materialRow),
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, material: null, error: error.message });
  }
});

app.patch('/api/materials/:barcode/scan/reset', requirePermission('inventory.update'), async (req, res) => {
  try {
    const updatedRow = await resetMaterialScanCount(req.params.barcode, currentActor(req));
    if (!updatedRow) {
      res.status(404).json({
        success: false,
        material: null,
        error: `No material found for barcode ${req.params.barcode}.`,
      });
      return;
    }
    res.json({
      success: true,
      material: rowToMaterialDto(updatedRow),
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, material: null, error: error.message });
  }
});

app.post('/api/inventory/movements', requirePermission('inventory.update'), async (req, res) => {
  try {
    const detail = await applyInventoryMovement({
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
    const events = await getMaterialActivity(req.params.barcode);
    res.json({
      success: true,
      events: events.map(rowToMaterialActivityDto),
      error: null,
    });
  } catch (error) {
    res.status(500).json({ success: false, events: [], error: error.message });
  }
});

};
