'use strict';

// ---------------------------------------------------------------------------
// Search module — HTTP routes.
//
// All 4 route registrations for search territory moved VERBATIM from server.js.
// No logic edits; handler bodies are NOT re-indented. Registration order matches
// server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerSearchModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    all,
    run,
  } = ctx;

app.get('/api/search', requirePermission('inventory.read'), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json({ success: true, results: [] });
    }

    if (ctx.searchEntities) {
      const results = await ctx.searchEntities(q, req.user?.id);
      return res.json({ success: true, results });
    }
    
    return res.json({ success: true, results: [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/search/history', requirePermission('inventory.read'), async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.json({ success: true, history: [] });
    }
    const history = await all(
      'SELECT query, MAX(created_at) as last_searched FROM search_history WHERE user_id = ? GROUP BY query ORDER BY last_searched DESC LIMIT 10',
      [userId]
    );
    res.json({ success: true, history: history.map(h => h.query) });
  } catch (error) {
    res.status(500).json({ success: false, history: [], error: error.message });
  }
});

app.post('/api/search/history', requirePermission('inventory.read'), async (req, res) => {
  try {
    const userId = req.user?.id;
    const { query } = req.body;
    if (userId && query) {
      await run(
        'INSERT INTO search_history (user_id, query, created_at) VALUES (?, ?, ?)',
        [userId, String(query).trim(), new Date().toISOString()]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/search/clicks', requirePermission('inventory.read'), async (req, res) => {
  try {
    const userId = req.user?.id;
    const { query, entityType, entityId, entityLabel } = req.body;
    if (userId && entityType && entityId) {
      await run(
        'INSERT INTO search_clicks (user_id, query, entity_type, entity_id, entity_label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, query || '', entityType, String(entityId), entityLabel || '', new Date().toISOString()]
      );
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

};
