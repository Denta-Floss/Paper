'use strict';

// ---------------------------------------------------------------------------
// Units master over HTTP: units and unit groups (families), their create, edit
// and archive routes. The families-with-units and seed routes are in routes.js.
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
// URLs, guards and the order routes are matched in are exactly as they were:
// they are registered into a router that holds the place they had in server.js.
//
// The work is the module's operations (./operations.js), asked for at the
// kernel desk. A handler translates a request into an operation's input and its
// result into the answer the app has always had, and writes the Track entry,
// which needs the request. It is handed neither the database nor the service.
// ---------------------------------------------------------------------------
function registerUnitMasterRoutes(app, {
  cacheMasterData,
  desk,
  requirePermission,
  trackCreate,
  trackDelete,
  trackUpdate,
}) {
  const ask = (req, name, input) => desk.call(name, input, { actor: desk.actorFromRequest(req) });
  const refuse = (res, result, extra = {}) =>
    res.status(result.status || 400).json({ success: false, ...extra, error: result.error });

  app.get('/api/units', requirePermission('config.read'), cacheMasterData, async (req, res) => {
    try {
      const result = await ask(req, 'units.list');
      if (!result.ok) return refuse(res, result, { units: [] });
      res.json({ success: true, units: result.units, error: null });
    } catch (error) {
      res.status(500).json({ success: false, units: [], error: error.message });
    }
  });

  app.post('/api/units', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'units.create', { ...(req.body || {}) });
      if (!result.ok) return refuse(res, result, { unit: null });
      trackCreate('units', result.row.id, result.row, req);
      res.status(201).json({ success: true, unit: result.unit, error: null });
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
      const result = await ask(req, 'units.update', { ...(req.body || {}), id });
      if (!result.ok) return refuse(res, result, { unit: null });
      trackUpdate('units', id, result.before, result.after, req);
      res.json({ success: true, unit: result.unit, error: null });
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
      const result = await ask(req, 'units.families.list');
      if (!result.ok) return refuse(res, result, { unitGroups: [] });
      res.json({ success: true, unitGroups: result.unitGroups, error: null });
    } catch (error) {
      res.status(500).json({ success: false, unitGroups: [], error: error.message });
    }
  });

  app.post('/api/unit-groups', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'units.families.create', { ...(req.body || {}) });
      if (!result.ok) return refuse(res, result);
      res.status(201).json({ success: true, unitGroup: result.unitGroup, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/unit-groups/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'units.families.update', { ...(req.body || {}), id });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, unitGroup: result.unitGroup, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/unit-groups/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'units.families.delete', { id: Number(req.params.id) });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/units/gauge-table', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'units.gaugeTable');
      if (!result.ok) return refuse(res, result, { points: [] });
      res.json({ success: true, points: result.points, error: null });
    } catch (error) {
      res.status(500).json({ success: false, points: [], error: error.message });
    }
  });

  app.post('/api/units/convert-batch', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'units.convertBatch', { conversions: req.body.conversions });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, results: result.results });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.patch('/api/units/:id/archive', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'units.archive', { id: Number(req.params.id) });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/units/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await ask(req, 'units.delete', { id });
      if (!result.ok) return refuse(res, result);
      trackDelete('units', id, result.before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = {
  registerUnitMasterRoutes,
};
