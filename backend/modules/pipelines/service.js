'use strict';

// ---------------------------------------------------------------------------
// Pipeline templates: the node graphs a production run is started from.
//
// The server answers templates on two route sets that do NOT behave alike, and
// this service keeps both, named for the set they serve:
//
//   api*   /api/production/pipeline-templates   the app's own
//   root*  /templates                           the older set, outside /api
//
// They differ in the version (the api set takes it from the body, the root set
// starts at 1 and bumps on every update), in what an update does to fields it
// is not sent, in the pen-and-paper baseline (only the api set stores it), and
// in whether delete looks at runs. Merging them is a separate decision.
//
// Takes {get, all, run, parseJson}. rowToTemplate is exported for production,
// which shapes templates it has already read when it starts a run.
// ---------------------------------------------------------------------------

function createPipelineService({ get, all, run, parseJson }) {
  function rowToTemplate(row) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      factoryId: row.factory_id || '',
      shopFloorId: row.shop_floor_id || '',
      name: row.name,
      description: row.description || '',
      version: row.version || 1,
      status: row.status || 'draft',
      stageLabels: parseJson(row.stage_labels_json, []),
      laneLabels: parseJson(row.lane_labels_json, []),
      nodes: parseJson(row.nodes_json, []),
      flows: parseJson(row.flows_json, []),
      intermediateNamingConvention: row.intermediate_naming_convention || '',
      penPaperBaseline: parseJson(row.pen_paper_baseline_json, null),
      blankWidthMm: Number(row.blank_width_mm || 0),
      blankHeightMm: Number(row.blank_height_mm || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function getTemplateRow(id) {
    return get('SELECT * FROM pipeline_templates WHERE id = ?', [id]);
  }

  // --- the api set ----------------------------------------------------------

  async function apiListTemplates(factoryId) {
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
    return rows.map(rowToTemplate);
  }

  /// Insert, or replace the template with this id.
  async function apiSaveTemplate(data) {
    const now = new Date().toISOString();

    await run(
      `
      INSERT OR REPLACE INTO pipeline_templates (
        id, factory_id, shop_floor_id, name, description, version, status,
        stage_labels_json, lane_labels_json, nodes_json, flows_json, intermediate_naming_convention, pen_paper_baseline_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        data.penPaperBaseline ? JSON.stringify(data.penPaperBaseline) : '{}',
        now,
        now
      ]
    );

    return getTemplateRow(data.id);
  }

  async function apiUpdateTemplate(id, data) {
    const now = new Date().toISOString();

    const existing = await getTemplateRow(id);
    if (!existing) {
      return { refusal: { status: 404, body: { success: false, template: null, error: 'Not found' } } };
    }

    await run(
      `
      UPDATE pipeline_templates
      SET factory_id = ?, shop_floor_id = ?, name = ?, description = ?, version = ?, status = ?,
          stage_labels_json = ?, lane_labels_json = ?, nodes_json = ?, flows_json = ?, intermediate_naming_convention = ?, pen_paper_baseline_json = ?, updated_at = ?
      WHERE id = ?
      `,
      [
        data.factoryId ?? existing.factory_id,
        data.shopFloorId ?? existing.shop_floor_id,
        data.name ?? existing.name,
        data.description ?? existing.description,
        data.version ?? 1,
        data.status ?? existing.status,
        data.stageLabels ? JSON.stringify(data.stageLabels) : existing.stage_labels_json,
        data.laneLabels ? JSON.stringify(data.laneLabels) : existing.lane_labels_json,
        data.nodes ? JSON.stringify(data.nodes) : existing.nodes_json,
        data.flows ? JSON.stringify(data.flows) : existing.flows_json,
        data.intermediateNamingConvention ?? existing.intermediate_naming_convention,
        data.penPaperBaseline ? JSON.stringify(data.penPaperBaseline) : existing.pen_paper_baseline_json,
        now,
        id
      ]
    );

    return { existing, row: await getTemplateRow(id) };
  }

  async function deleteTemplateRow(id) {
    const before = await getTemplateRow(id);
    await run('DELETE FROM pipeline_templates WHERE id = ?', [id]);
    return before;
  }

  // --- the root set ---------------------------------------------------------

  async function rootListTemplates() {
    const rows = await all(
      'SELECT * FROM pipeline_templates ORDER BY updated_at DESC, name ASC',
    );
    return rows.map(rowToTemplate);
  }

  async function rootCreateTemplate(payload) {
    if (!payload.id || !payload.name) {
      return { refusal: { status: 400, body: { success: false, template: null, error: 'id and name are required.' } } };
    }
    const now = new Date().toISOString();
    await run(
      `
      INSERT INTO pipeline_templates (
        id, factory_id, shop_floor_id, name, description, version, status, stage_labels_json, lane_labels_json,
        nodes_json, flows_json, intermediate_naming_convention, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        payload.id,
        payload.factoryId || payload.factory_id || '',
        payload.shopFloorId || payload.shop_floor_id || '',
        payload.name,
        payload.description || '',
        1,
        payload.status || 'draft',
        JSON.stringify(payload.stageLabels || []),
        JSON.stringify(payload.laneLabels || []),
        JSON.stringify(payload.nodes || []),
        JSON.stringify(payload.flows || []),
        payload.intermediateNamingConvention || payload.intermediate_naming_convention || '',
        now,
        now,
      ],
    );
    return { row: await getTemplateRow(payload.id) };
  }

  async function rootUpdateTemplate(id, payload) {
    const existing = await getTemplateRow(id);
    if (!existing) {
      return { refusal: { status: 404, body: { success: false, template: null, error: 'Template not found.' } } };
    }
    const nextVersion = (existing.version || 1) + 1;
    const now = new Date().toISOString();
    await run(
      `
      UPDATE pipeline_templates
      SET factory_id = ?, shop_floor_id = ?, name = ?, description = ?, version = ?, status = ?,
          stage_labels_json = ?, lane_labels_json = ?, nodes_json = ?, flows_json = ?, intermediate_naming_convention = ?, updated_at = ?
      WHERE id = ?
      `,
      [
        payload.factoryId || payload.factory_id || existing.factory_id || '',
        payload.shopFloorId || payload.shop_floor_id || existing.shop_floor_id || '',
        payload.name || existing.name,
        payload.description || existing.description || '',
        nextVersion,
        payload.status || existing.status || 'draft',
        JSON.stringify(payload.stageLabels || parseJson(existing.stage_labels_json, [])),
        JSON.stringify(payload.laneLabels || parseJson(existing.lane_labels_json, [])),
        JSON.stringify(payload.nodes || parseJson(existing.nodes_json, [])),
        JSON.stringify(payload.flows || parseJson(existing.flows_json, [])),
        payload.intermediateNamingConvention ?? payload.intermediate_naming_convention ?? existing.intermediate_naming_convention ?? '',
        now,
        id,
      ],
    );
    return { row: await getTemplateRow(id) };
  }

  return {
    rowToTemplate,
    getTemplateRow,
    apiListTemplates,
    apiSaveTemplate,
    apiUpdateTemplate,
    deleteTemplateRow,
    rootListTemplates,
    rootCreateTemplate,
    rootUpdateTemplate,
  };
}

module.exports = { createPipelineService };
