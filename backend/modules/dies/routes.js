'use strict';

// ---------------------------------------------------------------------------
// The die master over HTTP.
//
//   GET    /api/dies                              the list (cached master data)
//   GET    /api/dies/:id                          one, with its client
//   POST   /api/dies                              create, or update when `id` is a real one
//   DELETE /api/dies/:id                          remove, unless a live run holds it
//   GET    /api/dies/:id/assets                   its photos
//   POST   /api/dies/:id/assets/upload-intent     ask for somewhere to put one
//   POST   /api/dies/:id/assets/upload-complete   say it arrived
//
// `dies` is the first path segment, so the central CRUD gate maps every route
// here to the dies module. Handlers are the ones that lived in server.js, moved
// whole. The die makers master is the sibling file, die-makers.js.
// ---------------------------------------------------------------------------

module.exports = function registerDieRoutes(ctx) {
  const {
    app,
    requirePermission,
    cacheMasterData,
    trackCreate,
    trackUpdate,
    trackDelete,
    dies,
    production,
    // Assets are a kernel capability still defined in server.js.
    listAssetsForEntity,
    createAssetUploadIntent,
    completeAssetUpload,
    // Late-bound: the links and variations modules mount after this one.
    getPurgeEntityLinks,
    getPurgeEntityVariations,
  } = ctx;

  // Dies CRUD Endpoints
  app.get('/api/dies', requirePermission('config.read'), cacheMasterData, async (req, res) => {
    try {
      res.json({ success: true, dies: await dies.listDies(), error: null });
    } catch (error) {
      res.status(500).json({ success: false, dies: [], error: error.message });
    }
  });

  app.get('/api/dies/:id', requirePermission('config.read'), async (req, res) => {
    try {
      const die = await dies.getDie(req.params.id);
      if (!die) {
        return res.status(404).json({ success: false, die: null, error: 'Die not found' });
      }
      res.json({ success: true, die, error: null });
    } catch (error) {
      res.status(500).json({ success: false, die: null, error: error.message });
    }
  });

  app.post('/api/dies', requirePermission('config.write'), async (req, res) => {
    try {
      const saved = await dies.saveDie(req.body);
      if (saved.refusal) {
        return res.status(saved.refusal.status).json(saved.refusal.body);
      }
      if (saved.isUpdate) {
        trackUpdate('dies', saved.resultId, saved.beforeRow, saved.row, req);
      } else {
        trackCreate('dies', saved.resultId, saved.row, req);
      }
      res.json({ success: true, die: saved.die, error: null });
    } catch (error) {
      res.status(500).json({ success: false, die: null, error: error.message });
    }
  });

  app.delete('/api/dies/:id', requirePermission('config.write'), async (req, res) => {
    try {
      const id = req.params.id;
      if (await production.dieAssignedToActiveRun(id)) {
        return res.status(400).json({ success: false, error: 'Cannot delete die: assigned to an active pipeline run.' });
      }
      const before = await dies.deleteDie(id);
      const purgeEntityLinks = getPurgeEntityLinks();
      const purgeEntityVariations = getPurgeEntityVariations();
      if (purgeEntityLinks) await purgeEntityLinks('die', id);
      if (purgeEntityVariations) await purgeEntityVariations('die', id);
      trackDelete('dies', id, before, req);
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Dies Assets
  app.get('/api/dies/:id/assets', requirePermission('config.read'), async (req, res) => {
    try {
      const assets = await listAssetsForEntity('die', Number(req.params.id));
      res.json({ success: true, assets, error: null });
    } catch (error) {
      res.status(500).json({ success: false, assets: [], error: error.message });
    }
  });

  app.post('/api/dies/:id/assets/upload-intent', requirePermission('config.write'), async (req, res) => {
    try {
      const entityId = Number(req.params.id);
      const intent = await createAssetUploadIntent({
        ...(req.body || {}),
        entityType: 'die',
        entityId,
      });
      res.status(intent.alreadyUploaded ? 200 : 201).json({ success: true, intent, error: null });
    } catch (error) {
      res.status(500).json({ success: false, intent: null, error: error.message });
    }
  });

  app.post('/api/dies/:id/assets/upload-complete', requirePermission('config.write'), async (req, res) => {
    try {
      const asset = await completeAssetUpload(req.body || {});
      res.json({ success: true, asset, error: null });
    } catch (error) {
      res.status(500).json({ success: false, asset: null, error: error.message });
    }
  });
};
