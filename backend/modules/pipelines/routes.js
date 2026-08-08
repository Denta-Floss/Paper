'use strict';

// ---------------------------------------------------------------------------
// Pipelines module — HTTP routes.
//
// All 4 route registrations for pipelines territory (production/pipeline-templates)
// moved VERBATIM from server.js. No logic edits; handler bodies are NOT re-indented.
// Registration order matches server.js exactly.
// ---------------------------------------------------------------------------

module.exports = function registerPipelinesModuleRoutes(ctx) {
  const {
    app,
    requirePermission,
    get,
    all,
    run,
    rowToTemplate,
    trackCreate,
    trackUpdate,
    trackDelete,
    countPipelineRunsForTemplate,
  } = ctx;

app.get('/api/production/pipeline-templates', requirePermission('config.read'), async (req, res) => {
  try {
    const factoryId = req.query.factoryId;
    let rows;
    if (factoryId) {
      rows = await all(
        'SELECT * FROM pipeline_templates WHERE factory_id = ? OR factory_id = "" ORDER BY created_at DESC',
        [factoryId]
      );
    } else {
      rows = await all(
        'SELECT * FROM pipeline_templates ORDER BY created_at DESC'
      );
    }
    res.json({ success: true, templates: rows.map(rowToTemplate), error: null });
  } catch (error) {
    res.status(500).json({ success: false, templates: [], error: error.message });
  }
});

app.post('/api/production/pipeline-templates', requirePermission('config.write'), async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();
    
    await run(
      `
      INSERT INTO pipeline_templates (
        id, factory_id, shop_floor_id, name, description, version, status,
        stage_labels_json, lane_labels_json, nodes_json, flows_json, intermediate_naming_convention, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        data.id,
        data.factoryId || '',
        data.shopFloorId || '',
        data.name || 'Untitled',
        data.description || '',
        data.version || 1,
        data.status || 'draft',
        JSON.stringify(data.stageLabels || []),
        JSON.stringify(data.laneLabels || []),
        JSON.stringify(data.nodes || []),
        JSON.stringify(data.flows || []),
        data.intermediateNamingConvention || '',
        now,
        now
      ]
    );

    const row = await get('SELECT * FROM pipeline_templates WHERE id = ?', [data.id]);
    trackCreate('pipeline_templates', row.id, row, req);
    res.json({ success: true, template: rowToTemplate(row), error: null });
  } catch (error) {
    res.status(500).json({ success: false, template: null, error: error.message });
  }
});

app.put('/api/production/pipeline-templates/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = req.params.id;
    const data = req.body;
    const now = new Date().toISOString();

    const existing = await get('SELECT * FROM pipeline_templates WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, template: null, error: 'Not found' });
    }
    
    await run(
      `
      UPDATE pipeline_templates
      SET factory_id = ?, shop_floor_id = ?, name = ?, description = ?, version = ?, status = ?,
          stage_labels_json = ?, lane_labels_json = ?, nodes_json = ?, flows_json = ?, intermediate_naming_convention = ?, updated_at = ?
      WHERE id = ?
      `,
      [
        data.factoryId ?? existing.factory_id,
        data.shopFloorId ?? existing.shop_floor_id,
        data.name ?? existing.name,
        data.description ?? existing.description,
        data.version ?? nextVersion,
        data.status ?? existing.status,
        data.stageLabels ? JSON.stringify(data.stageLabels) : existing.stage_labels_json,
        data.laneLabels ? JSON.stringify(data.laneLabels) : existing.lane_labels_json,
        data.nodes ? JSON.stringify(data.nodes) : existing.nodes_json,
        data.flows ? JSON.stringify(data.flows) : existing.flows_json,
        data.intermediateNamingConvention ?? existing.intermediate_naming_convention,
        now,
        id
      ]
    );

    const row = await get('SELECT * FROM pipeline_templates WHERE id = ?', [id]);
    trackUpdate('pipeline_templates', id, existing, row, req);
    res.json({ success: true, template: rowToTemplate(row), error: null });
  } catch (error) {
    res.status(500).json({ success: false, template: null, error: error.message });
  }
});

app.delete('/api/production/pipeline-templates/:id', requirePermission('config.write'), async (req, res) => {
  try {
    const id = req.params.id;
    const runsCount = await countPipelineRunsForTemplate(id);
    if (runsCount && runsCount.count > 0) {
      return res.status(400).json({ success: false, error: 'Cannot delete pipeline template: there are ongoing or historical runs using it.' });
    }
    const before = await get('SELECT * FROM pipeline_templates WHERE id = ?', [id]);
    await run('DELETE FROM pipeline_templates WHERE id = ?', [id]);
    trackDelete('pipeline_templates', id, before, req);
    res.json({ success: true, error: null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

};
