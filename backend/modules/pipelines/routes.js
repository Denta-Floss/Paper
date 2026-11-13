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
// Handlers are the ones that lived in server.js, moved whole.
// ---------------------------------------------------------------------------

module.exports = function registerPipelineRoutes(ctx) {
  const {
    app,
    requirePermission,
    trackCreate,
    trackUpdate,
    trackDelete,
    pipelines,
    production,
  } = ctx;

  // --- /api/production/pipeline-templates -----------------------------------

  app.get('/api/production/pipeline-templates', requirePermission('config.read'), async (req, res) => {
    try {
      const templates = await pipelines.apiListTemplates(req.query.factoryId);
      res.json({ success: true, templates, error: null });
    } catch (error) {
      res.status(500).json({ success: false, templates: [], error: error.message });
    }
  });

  app.post('/api/production/pipeline-templates', requirePermission('config.write'), async (req, res) => {
    try {
      const row = await pipelines.apiSaveTemplate(req.body);
      trackCreate('pipeline_templates', row.id, row, req);
      res.json({ success: true, template: pipelines.rowToTemplate(row), error: null });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.put('/api/production/pipeline-templates/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = req.params.id;
      const saved = await pipelines.apiUpdateTemplate(id, req.body);
      if (saved.refusal) {
        return res.status(saved.refusal.status).json(saved.refusal.body);
      }
      trackUpdate('pipeline_templates', id, saved.existing, saved.row, req);
      res.json({ success: true, template: pipelines.rowToTemplate(saved.row), error: null });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.delete('/api/production/pipeline-templates/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = req.params.id;
      if ((await production.templateRunCount(id)) > 0) {
        return res.status(400).json({ success: false, error: 'Cannot delete pipeline template: there are ongoing or historical runs using it.' });
      }
      const before = await pipelines.deleteTemplateRow(id);
      trackDelete('pipeline_templates', id, before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // --- /templates (the root set) --------------------------------------------

  app.get('/templates', requirePermission('config.read'), async (req, res) => {
    try {
      res.json({ success: true, templates: await pipelines.rootListTemplates() });
    } catch (error) {
      res.status(500).json({ success: false, templates: [], error: error.message });
    }
  });

  app.post('/templates', async (req, res) => {
    try {
      const made = await pipelines.rootCreateTemplate(req.body || {});
      if (made.refusal) {
        res.status(made.refusal.status).json(made.refusal.body);
        return;
      }
      res.status(201).json({ success: true, template: pipelines.rowToTemplate(made.row) });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.put('/templates/:id', async (req, res) => {
    try {
      const saved = await pipelines.rootUpdateTemplate(req.params.id, req.body || {});
      if (saved.refusal) {
        res.status(saved.refusal.status).json(saved.refusal.body);
        return;
      }
      res.json({ success: true, template: pipelines.rowToTemplate(saved.row) });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.get('/templates/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const row = await pipelines.getTemplateRow(req.params.id);
      if (!row) {
        res.status(404).json({
          success: false,
          template: null,
          error: 'Template not found.',
        });
        return;
      }
      res.json({ success: true, template: pipelines.rowToTemplate(row) });
    } catch (error) {
      res.status(500).json({ success: false, template: null, error: error.message });
    }
  });

  app.delete('/templates/:id', async (req, res) => {
    try {
      const existing = await pipelines.getTemplateRow(req.params.id);
      if (!existing) {
        res.status(404).json({ success: false, error: 'Template not found.' });
        return;
      }
      await pipelines.deleteTemplateRow(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
};
