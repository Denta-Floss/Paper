'use strict';

// ---------------------------------------------------------------------------
// Settings a workspace keeps for itself: a user's favourites, the company
// profile printed on documents, and the signals the phone app sends the desktop.
//
//   GET    /api/favorites
//   POST   /api/favorites
//   DELETE /api/favorites/:itemId/:variationLeafNodeId
//   GET    /api/company-profile
//   PUT    /api/company-profile
//   POST   /api/mobile/stage-item
//   POST   /api/mobile/remove-staged-item
//   POST   /api/mobile/lock-inventory
//   POST   /api/mobile/challan-generated
//
// URLs, guards and the order routes are matched in are exactly as they were in
// server.js: each group below is registered into a router that holds the place
// its routes had there. Handlers are moved whole. What they use from the rest
// of the server (the database helpers, the permission checks, shared services)
// is handed in by name.
// ---------------------------------------------------------------------------
function registerSettingsRoutes(app, {
  all,
  getActiveCompanyProfile,
  requirePermission,
  rowToCompanyProfileDto,
  run,
  saveCompanyProfile,
}) {
  app.get('/api/favorites', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const rows = await all(
        'SELECT item_id, variation_leaf_node_id, variation_path_label, variation_path_node_ids, custom_variation_values FROM user_favorite_items WHERE user_id = ?',
        [userId]
      );
      res.json({
        success: true,
        favorites: rows.map(r => ({
          itemId: r.item_id,
          variationLeafNodeId: r.variation_leaf_node_id,
          variationPathLabel: r.variation_path_label,
          variationPathNodeIds: JSON.parse(r.variation_path_node_ids),
          customVariationValues: JSON.parse(r.custom_variation_values),
        })),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/favorites', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const {
        itemId,
        variationLeafNodeId = 0,
        variationPathLabel = '',
        variationPathNodeIds = [],
        customVariationValues = {}
      } = req.body;

      if (!itemId) {
        return res.status(400).json({ success: false, error: 'itemId is required' });
      }

      await run(
        `INSERT INTO user_favorite_items (
          user_id, item_id, variation_leaf_node_id, variation_path_label, variation_path_node_ids, custom_variation_values, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT DO NOTHING`,
        [
          userId,
          itemId,
          variationLeafNodeId,
          variationPathLabel,
          JSON.stringify(variationPathNodeIds),
          JSON.stringify(customVariationValues)
        ]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/favorites/:itemId/:variationLeafNodeId', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
      const itemId = Number(req.params.itemId);
      const variationLeafNodeId = Number(req.params.variationLeafNodeId);

      await run(
        'DELETE FROM user_favorite_items WHERE user_id = ? AND item_id = ? AND variation_leaf_node_id = ?',
        [userId, itemId, variationLeafNodeId]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/company-profile', requirePermission('config.read'), async (_req, res) => {
    try {
      const profile = await getActiveCompanyProfile();
      res.json({ success: true, data: rowToCompanyProfileDto(profile), error: null });
    } catch (error) {
      res.status(500).json({ success: false, data: null, error: error.message });
    }
  });

  app.put('/api/company-profile', requirePermission('config.write'), async (req, res) => {
    try {
      const profile = await saveCompanyProfile(req.body || {});
      res.json({ success: true, data: rowToCompanyProfileDto(profile), error: null });
    } catch (error) {
      res.status(error.statusCode || 500).json({
        success: false,
        data: null,
        error: error.message,
      });
    }
  });
}

// These are registered after the /api error handler that sits in the middle of
// server.js, as they always were, so an error they pass on is caught by the
// last handler instead.
function registerSettingsRoutesAfterErrorHandler(app, {
  changeEmitter,
  requireAuth,
}) {
  app.post('/api/mobile/stage-item', requireAuth, async (req, res) => {
    try {
      changeEmitter.emit('custom-event', { event: 'item_staged', data: req.body });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/mobile/remove-staged-item', requireAuth, async (req, res) => {
    try {
      changeEmitter.emit('custom-event', { event: 'item_removed', data: req.body });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/mobile/lock-inventory', requireAuth, async (req, res) => {
    try {
      changeEmitter.emit('custom-event', { event: 'inventory_locked', data: req.body });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/mobile/challan-generated', requireAuth, async (req, res) => {
    try {
      changeEmitter.emit('custom-event', { event: 'challan_generated_ok', data: req.body });
      res.json({ success: true, error: null });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = {
  registerSettingsRoutes,
  registerSettingsRoutesAfterErrorHandler,
};
