'use strict';

// ---------------------------------------------------------------------------
// Process routing module — HTTP.
//
//   GET  /api/process-stages                   the factory's stage master
//   POST /api/process-stages                   add a stage — a name is all it takes
//   DELETE /api/process-stages/:id             retire one no route stands on
//   GET  /api/items/:id/routes                 every version, active first
//   POST /api/items/:id/routes                 save a route (draft or active)
//   POST /api/items/:id/routes/versions        declare a new version
//
// PATHS. The doc calls the owner a "part"; this schema calls it an item and
// every existing endpoint is /api/items. `/api/parts/...` would have been both
// a second name for one thing AND an ungated one: moduleOpForRequest maps the
// FIRST path segment to a module, and an unmapped segment returns null, which
// means no per-module CRUD check at all (the hole pattern that let payroll
// reads through). Nesting under /api/items inherits items.read / items.create
// and, because recordIdForRequest reads the segment after the module, the
// per-record grants as well. `process-stages` is a new segment, so it is
// declared in that map — one line, in the ['items', 'groups'] list.
//
// Every save goes through one endpoint and one validator, whichever screen sent
// it: the Classic dropdown view and the List drag view both POST the same
// ordered list of stage ids.
// ---------------------------------------------------------------------------

module.exports = function registerProcessRoutesModule(ctx) {
  const { app, desk, requirePermission, trackCreate, trackUpdate } = ctx;

  // The module's work is its operations (./operations.js), asked for at the
  // kernel desk. A handler here only translates: request in, result out, and
  // the Track entry, which needs the request for its actor and sitting.
  const ask = (req, name, input) => desk.call(name, input, { actor: desk.actorFromRequest(req) });

  /// A refusal as the app has always received it: the error, its code, and
  /// whatever the operation attached so the caller has somewhere to go (the
  /// stage that already has the name, the route to version, the use count).
  function refuse(res, result) {
    const { ok, status, ...detail } = result;
    res.status(status || 400).json({ success: false, ...detail });
  }

  app.get('/api/process-stages', requirePermission('items.read'), async (req, res) => {
    try {
      const result = await ask(req, 'process_routes.stages.list', {
        includeInactive: String(req.query.includeInactive || '') === 'true',
      });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, stages: result.stages });
    } catch (error) {
      console.error('[Routes] stage master failed:', error);
      res.status(500).json({ success: false, error: 'Could not read the stage master.' });
    }
  });

  app.post('/api/process-stages', requirePermission('items.create'), async (req, res) => {
    try {
      const result = await ask(req, 'process_routes.stages.create', { name: req.body?.name });
      // The 409 carries the stage that already has this name, so the caller
      // can simply use it.
      if (!result.ok) return refuse(res, result);
      if (trackCreate) trackCreate('process_stages', result.stage.id, result.stage, req);
      res.status(201).json({ success: true, stage: result.stage });
    } catch (error) {
      console.error('[Routes] stage create failed:', error);
      res.status(500).json({ success: false, error: 'Could not add the stage.' });
    }
  });

  app.delete('/api/process-stages/:id', requirePermission('items.delete'), async (req, res) => {
    try {
      const result = await ask(req, 'process_routes.stages.retire', { id: req.params.id });
      if (!result.ok) return refuse(res, result);
      if (trackUpdate) {
        trackUpdate('process_stages', result.stage.id, { ...result.stage, active: 1 }, result.stage, req);
      }
      res.json({ success: true, stage: result.stage });
    } catch (error) {
      console.error('[Routes] stage delete failed:', error);
      res.status(500).json({ success: false, error: 'Could not delete the stage.' });
    }
  });

  app.get('/api/items/:id/routes', requirePermission('items.read'), async (req, res) => {
    try {
      const result = await ask(req, 'process_routes.routes.list', { partId: req.params.id });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, routes: result.routes });
    } catch (error) {
      console.error('[Routes] read failed:', error);
      res.status(500).json({ success: false, error: 'Could not read this part’s routes.' });
    }
  });

  app.post('/api/items/:id/routes', requirePermission('items.update'), async (req, res) => {
    try {
      const partId = Number(req.params.id);
      const result = await ask(req, 'process_routes.routes.save', {
        partId: req.params.id,
        steps: req.body?.steps,
        status: req.body?.status,
        note: req.body?.note,
      });
      if (!result.ok) return refuse(res, result);
      // A route is a part attribute with its own lifecycle, so it is logged
      // against the PART — that is the record somebody opens the Track tab on.
      // `route_created` / `route_versioned` in the doc's metric map are entity
      // lifecycle, which entity_activity_log already carries (and with them a
      // sitting, free, via logEntityActivity). The floor transitions
      // stage_entered / stage_exited belong to Stage tracking and are not this.
      const { pipelineName, ...saved } = result;
      const label = { name: `${pipelineName} v${saved.version}` };
      if (saved.created) trackCreate('items', partId, label, req);
      else trackUpdate('items', partId, { name: 'route' }, label, req);
      res.json({ success: true, ...saved });
    } catch (error) {
      console.error('[Routes] save failed:', error);
      res.status(500).json({ success: false, error: 'Could not save the route.' });
    }
  });

  app.post('/api/items/:id/routes/versions', requirePermission('items.update'), async (req, res) => {
    try {
      const partId = Number(req.params.id);
      const result = await ask(req, 'process_routes.routes.version', {
        partId: req.params.id,
        steps: req.body?.steps,
        note: req.body?.note,
      });
      if (!result.ok) return refuse(res, result);
      const { pipelineName, ...saved } = result;
      trackUpdate(
        'items',
        partId,
        { name: `${pipelineName} v${saved.previousVersion}` },
        { name: `${pipelineName} v${saved.version}` },
        req,
      );
      res.json({ success: true, ...saved });
    } catch (error) {
      console.error('[Routes] version failed:', error);
      res.status(500).json({ success: false, error: 'Could not declare a new version.' });
    }
  });
};
