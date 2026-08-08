'use strict';

// ---------------------------------------------------------------------------
// Production module — HTTP routes.
//
// All 3 route registrations for production territory (production-runs/completed,
// production-scrap) moved VERBATIM from server.js. No logic edits; handler bodies
// are NOT re-indented. Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerProductionModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
    listCompletedProductionRuns,
    recordProductionScrap,
  } = ctx;

app.get('/api/production-runs/completed', requirePermission('config.read'), async (req, res) => {
  try {
    const runs = await listCompletedProductionRuns({
      search: req.query.search || req.query.q || '',
      limit: req.query.limit || 25,
    });
    res.json({ success: true, data: runs, productionRuns: runs, error: null });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      data: [],
      productionRuns: [],
      message: error.message,
      error: error.message,
    });
  }
});

app.post('/api/production-scrap', requirePermission('config.write'), async (req, res) => {
  try {
    const { pipelineRunId, nodeId, orderNo, materialBarcode, scrapQty, scrapItemId, scrapItemName } = req.body;
    if (!pipelineRunId || !nodeId || !materialBarcode) {
      return res.status(400).json({ success: false, error: 'pipelineRunId, nodeId, and materialBarcode are required.' });
    }

    await recordProductionScrap({
      pipelineRunId,
      nodeId,
      orderNo,
      materialBarcode,
      scrapQty,
      scrapItemId,
      scrapItemName,
      req,
    });

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Scrap error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/production-scrap', requirePermission('config.read'), async (req, res) => {
  try {
    const { pipelineRunId, nodeId } = req.query;
    let query = 'SELECT * FROM production_scrap WHERE 1=1';
    const params = [];
    if (pipelineRunId) {
      query += ' AND pipeline_run_id = ?';
      params.push(pipelineRunId);
    }
    if (nodeId) {
      query += ' AND node_id = ?';
      params.push(nodeId);
    }
    query += ' ORDER BY created_at DESC';
    const rows = await all(query, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

};
