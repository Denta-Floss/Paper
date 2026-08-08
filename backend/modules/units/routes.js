'use strict';

// ---------------------------------------------------------------------------
// Units module — HTTP routes.
//
// All 11 route registrations for units and unit-groups territory moved
// VERBATIM from server.js. No logic edits; handler bodies are NOT re-indented.
// Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerUnitsModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
    saveUnit,
    rowToUnitDto,
    getUnitsWithUsage,
    getUnitUsageCount,
    saveUnitGroup,
    rowToUnitGroupDto,
    buildUnitGraph,
    parseQualifiedValue,
    convertValue,
    trackCreate,
    trackUpdate,
    trackDelete,
    trashAndDelete,
  } = ctx;

app.get('/api/units', requirePermission('config.read'), async (req, res) => {
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
    const count = await getUnitUsageCount(id);
    if (count > 0) {
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

};
