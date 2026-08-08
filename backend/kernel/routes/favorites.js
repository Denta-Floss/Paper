'use strict';

// ---------------------------------------------------------------------------
// Kernel Favorites routes.
//
// Mounted directly from server.js with zero modifications to handlers or order.
// ---------------------------------------------------------------------------

module.exports = function registerFavoritesKernelRoutes(ctx) {
  const {
    app,
    all,
    run,
  } = ctx;

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

};
