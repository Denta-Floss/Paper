'use strict';

// ---------------------------------------------------------------------------
// Units master: units and unit groups (families), their create, edit and
// archive routes. The conversion engine's own routes are in routes.js.
//
//   GET    /api/units
//   POST   /api/units
//   PATCH  /api/units/:id
//   GET    /api/unit-groups
//   POST   /api/unit-groups
//   PATCH  /api/unit-groups/:id
//   DELETE /api/unit-groups/:id
//   GET    /api/units/gauge-table
//   POST   /api/units/convert-batch
//   PATCH  /api/units/:id/archive
//   DELETE /api/units/:id
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
function registerUnitMasterRoutes(app, {
  all,
  buildUnitGraph,
  cacheMasterData,
  convertValue,
  get,
  getUnitsWithUsage,
  parseQualifiedValue,
  requirePermission,
  rowToUnitDto,
  rowToUnitGroupDto,
  run,
  saveUnit,
  saveUnitGroup,
  trackCreate,
  trackDelete,
  trackUpdate,
  trashAndDelete,
}) {
  app.get('/api/units', requirePermission('config.read'), cacheMasterData, async (req, res) => {
    try {
      const rows = await getUnitsWithUsage();
      res.json({ success: true, units: rows.map(rowToUnitDto), error: null });
    } catch (error) {
      res.status(500).json({ success: false, units: [], error: error.message });
    }
  });

  app.post('/api/units', requirePermission('config.write'), async (req, res) => {
    try {
      const unit = await saveUnit(req.body || {});
      trackCreate('units', unit.id, unit, req);
      res.status(201).json({ success: true, unit: rowToUnitDto(unit), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        unit: null,
        error: error.message,
      });
    }
  });

  app.patch('/api/units/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const before = await get('SELECT * FROM units WHERE id = ?', [id]);
      const unit = await saveUnit({
        ...(req.body || {}),
        id,
      });
      const after = await get('SELECT * FROM units WHERE id = ?', [id]);
      trackUpdate('units', id, before, after, req);
      res.json({ success: true, unit: rowToUnitDto(unit), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        unit: null,
        error: error.message,
      });
    }
  });

  app.get('/api/unit-groups', requirePermission('config.read'), async (req, res) => {
    try {
      const rows = await all('SELECT * FROM unit_groups');
      res.json({ success: true, unitGroups: rows.map(rowToUnitGroupDto), error: null });
    } catch (error) {
      res.status(500).json({ success: false, unitGroups: [], error: error.message });
    }
  });

  app.post('/api/unit-groups', requirePermission('config.write'), async (req, res) => {
    try {
      const group = await saveUnitGroup(req.body || {});
      res.status(201).json({ success: true, unitGroup: rowToUnitGroupDto(group), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/unit-groups/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const group = await saveUnitGroup({ ...(req.body || {}), id });
      res.json({ success: true, unitGroup: rowToUnitGroupDto(group), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/unit-groups/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      await run('DELETE FROM unit_groups WHERE id = ?', [id]);
      if (typeof buildUnitGraph === 'function') buildUnitGraph();
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/units/gauge-table', requirePermission('config.read'), async (req, res) => {
    try {
      const points = await all('SELECT * FROM unit_conversion_points');
      res.json({ success: true, points, error: null });
    } catch (error) {
      res.status(500).json({ success: false, points: [], error: error.message });
    }
  });

  app.post('/api/units/convert-batch', requirePermission('config.read'), (req, res) => {
    try {
      const { conversions = [] } = req.body;
      const results = conversions.map((conv) => {
        try {
          let fromUnitId = conv.fromUnitId;
          const toUnitId = conv.toUnitId;
        
          let value = conv.value;
          if (typeof value === 'string') {
            const parsed = parseQualifiedValue(value);
            value = parsed.value; 
            if (!fromUnitId && parsed.unit) {
              fromUnitId = parsed.unit.id;
            }
          }
        
          const converted = convertValue(value, fromUnitId, toUnitId);
          return { success: true, value: converted };
        } catch (err) {
          return { success: false, error: err.message };
        }
      });
      res.json({ success: true, results });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/units/:id/archive', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const unit = await get('SELECT * FROM units WHERE id = ?', [id]);
      if (!unit) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }
      const usage = await get(`
        SELECT
          (SELECT COUNT(*) FROM materials WHERE unit_id = ?) +
          (SELECT COUNT(*) FROM groups WHERE unit_id = ?) +
          (SELECT COUNT(*) FROM items WHERE unit_id = ?) +
          (SELECT COUNT(*) FROM item_unit_conversions WHERE unit_id = ?) +
          (SELECT COUNT(*) FROM order_items WHERE unit_id = ?) +
          (SELECT COUNT(*) FROM units WHERE conversion_base_unit_id = ?) +
          (SELECT COUNT(*) FROM order_material_requirements WHERE unit_id = ?) AS count
      `, [id, id, id, id, id, id, id]);
      if ((usage?.count || 0) > 0) {
        const error = new Error('Unit is in use');
        error.statusCode = 409;
        throw error;
      }
      await run('UPDATE units SET is_archived = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/units/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const before = await get('SELECT * FROM units WHERE id = ?', [id]);
      await trashAndDelete('units', id, req);
      trackDelete('units', id, before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = {
  registerUnitMasterRoutes,
};
