'use strict';

// ---------------------------------------------------------------------------
// The machine master over HTTP.
//
//   GET    /api/machines                              the list (cached master data)
//   GET    /api/machines/:id                          one
//   POST   /api/machines                              create, or update when `id` is a real one
//   DELETE /api/machines/:id                          remove, unless a live run holds it
//   GET    /api/machines/:id/assets                   its photos
//   POST   /api/machines/:id/assets/upload-intent     ask for somewhere to put one
//   POST   /api/machines/:id/assets/upload-complete   say it arrived
//
// `machines` is the first path segment, so the central CRUD gate maps every
// route here to the machines module. Handlers are the ones that lived in
// server.js, moved whole.
//
// NOT here: GET /api/machines/:id/queue. It reads pipeline_runs, so it is in
// modules/production/routes.js.
// ---------------------------------------------------------------------------

module.exports = function registerMachineRoutes(ctx) {
  const {
    app,
    requirePermission,
    cacheMasterData,
    trackCreate,
    trackUpdate,
    trackDelete,
    machines,
    production,
    // Assets are a kernel capability still defined in server.js.
    listAssetsForEntity,
    createAssetUploadIntent,
    completeAssetUpload,
    // Late-bound: the links and variations modules mount after this one.
    getPurgeEntityLinks,
    getPurgeEntityVariations,
  } = ctx;

  // Machines CRUD Endpoints
  app.get('/api/machines', requirePermission('config.read'), cacheMasterData, async (req, res) => {
    try {
      res.json({ success: true, machines: await machines.listMachines(), error: null });
    } catch (error) {
      res.status(500).json({ success: false, machines: [], error: error.message });
    }
  });

  app.get('/api/machines/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const machine = await machines.getMachine(req.params.id);
      if (!machine) {
        return res.status(404).json({ success: false, machine: null, error: 'Machine not found' });
      }
      res.json({ success: true, machine, error: null });
    } catch (error) {
      res.status(500).json({ success: false, machine: null, error: error.message });
    }
  });

  app.post('/api/machines', requirePermission('config.write'), async (req, res) => {
    try {
      const saved = await machines.saveMachine(req.body);
      if (saved.refusal) {
        return res.status(saved.refusal.status).json(saved.refusal.body);
      }
      if (saved.isUpdate) {
        trackUpdate('machines', saved.resultId, saved.beforeRow, saved.row, req);
      } else {
        trackCreate('machines', saved.resultId, saved.row, req);
      }
      res.json({ success: true, machine: saved.machine, error: null });
    } catch (error) {
      res.status(500).json({ success: false, machine: null, error: error.message });
    }
  });

  app.delete('/api/machines/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = req.params.id;
      if (await production.machineAssignedToActiveRun(id)) {
        return res.status(400).json({ success: false, error: 'Cannot delete machine: assigned to an active pipeline run.' });
      }
      const before = await machines.deleteMachine(id);
      const purgeEntityLinks = getPurgeEntityLinks();
      const purgeEntityVariations = getPurgeEntityVariations();
      if (purgeEntityLinks) await purgeEntityLinks('machine', id);
      if (purgeEntityVariations) await purgeEntityVariations('machine', id);
      trackDelete('machines', id, before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Machines Assets
  app.get('/api/machines/:id/assets', requirePermission('config.read'), async (req, res) => {
    try {
      const assets = await listAssetsForEntity('machine', Number(req.params.id));
      res.json({ success: true, assets, error: null });
    } catch (error) {
      res.status(500).json({ success: false, assets: [], error: error.message });
    }
  });

  app.post('/api/machines/:id/assets/upload-intent', requirePermission('config.write'), async (req, res) => {
    try {
      const entityId = Number(req.params.id);
      const intent = await createAssetUploadIntent({
        ...(req.body || {}),
        entityType: 'machine',
        entityId,
      });
      res.status(intent.alreadyUploaded ? 200 : 201).json({ success: true, intent, error: null });
    } catch (error) {
      res.status(500).json({ success: false, intent: null, error: error.message });
    }
  });

  app.post('/api/machines/:id/assets/upload-complete', requirePermission('config.write'), async (req, res) => {
    try {
      const asset = await completeAssetUpload(req.body || {});
      res.json({ success: true, asset, error: null });
    } catch (error) {
      res.status(500).json({ success: false, asset: null, error: error.message });
    }
  });
};
