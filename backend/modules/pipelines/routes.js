'use strict';

// ---------------------------------------------------------------------------
// Pipeline templates over HTTP, on the two route sets the server has always had.
//
//   /api/production/pipeline-templates     the app's own, inside the /api gate
//     GET    /                               all, or one factory's plus the shared
//     POST   /                               save (replaces a template with that id)
//     PUT    /:id                            change one; what is left out is kept
//     DELETE /:id                            remove, unless a run was started from it
//
//   /templates                             the older set, OUTSIDE /api
//     GET    /          POST /               list; create (id and name required)
//     GET    /:id       PUT /:id             read; change (bumps the version)
//     DELETE /:id                            remove (no run check)
//
// The first set is gated by the central CRUD gate (`production`, with a special
// case for this prefix). The second is NOT under /api, so the /api gate never
// sees it: it has its own auth and write guards, declared in server.js with
// app.use('/templates', ...) before these routes are registered, and those stay
// where they are. Do not "fix" that here; it is a behaviour, and the root
// set's own tests pin it.
//
// Both sets ask the module's operations (./operations.js) at the kernel desk.
// The second set's operations ask what its own guards ask: any signed-in user
// to read, `config.write` to change.
// ---------------------------------------------------------------------------

const { httpKit } = require('../../kernel/desk-kit');

module.exports = function registerPipelineRoutes(ctx) {
  const {
    app,
    desk,
    requirePermission,
    trackCreate,
    trackUpdate,
    trackDelete,
  } = ctx;
  const { ask, refuse } = httpKit(desk);

  // --- /api/production/pipeline-templates -----------------------------------

  app.get('/api/production/pipeline-templates', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'pipelines.templates.list', { factoryId: req.query.factoryId });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, templates: result.templates, error: null });
    } catch (error) {
      res.status(500).json({ success: false, templates: [], error: error.message });
    }
  });

  app.post('/api/production/pipeline-templates', requirePermission('config.write'), async (req, res) => {
    try {
      const result = await ask(req, 'pipelines.templates.save', { data: req.body });
      if (!result.ok) return refuse(res, result);
      trackCreate('pipeline_templates', result.row.id, result.row, req);
      res.json({ success: true, template: result.template, error: null });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.put('/api/production/pipeline-templates/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = req.params.id;
      const result = await ask(req, 'pipelines.templates.update', { id, data: req.body });
      if (!result.ok) return refuse(res, result);
      trackUpdate('pipeline_templates', id, result.before, result.row, req);
      res.json({ success: true, template: result.template, error: null });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.delete('/api/production/pipeline-templates/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = req.params.id;
      const result = await ask(req, 'pipelines.templates.delete', { id });
      if (!result.ok) return refuse(res, result);
      trackDelete('pipeline_templates', id, result.before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // --- /templates (the root set) --------------------------------------------

  app.get('/templates', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'pipelines.legacyTemplates.list');
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, templates: result.templates });
    } catch (error) {
      res.status(500).json({ success: false, templates: [], error: error.message });
    }
  });

  app.post('/templates', async (req, res) => {
    try {
      const result = await ask(req, 'pipelines.legacyTemplates.create', { data: req.body || {} });
      if (!result.ok) return refuse(res, result);
      res.status(201).json({ success: true, template: result.template });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.put('/templates/:id', async (req, res) => {
    try {
      const result = await ask(req, 'pipelines.legacyTemplates.update', {
        id: req.params.id,
        data: req.body || {},
      });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, template: result.template });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.get('/templates/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const result = await ask(req, 'pipelines.legacyTemplates.get', { id: req.params.id });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true, template: result.template });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.delete('/templates/:id', async (req, res) => {
    try {
      const result = await ask(req, 'pipelines.legacyTemplates.delete', { id: req.params.id });
      if (!result.ok) return refuse(res, result);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
};
