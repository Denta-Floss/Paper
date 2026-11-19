'use strict';

// An item and a group as the app shows them.
//
// A factory: `deps` is what server.js still owns (the database helpers and
// a few shared helpers), `api` is the items service being assembled, through
// which these reach the sibling files; both are read at call time.



function createDto(deps, api) {
  const { desk } = deps;
  const { all, get, parseJson } = deps;
  const developedForDto = (...args) => api.developedForDto(...args);
  const getItemPropertySchema = (...args) => api.getItemPropertySchema(...args);
  const getItemVariationTree = (...args) => api.getItemVariationTree(...args);

  function rowToGroupDto(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name || '',
      groupType: row.group_type || 'item',
      groupStructure: row.group_structure || 'hierarchical',
      description: row.description || '',
      parentGroupId: row.parent_group_id || null,
      unitId: row.unit_id || null,
      // null when the group has no override and items fall back to the creating
      // user's own default section layout.
      itemFormSections: (() => {
        try {
          return row.item_form_sections ? JSON.parse(row.item_form_sections) : null;
        } catch (e) {
          return null;
        }
      })(),
      isArchived: Boolean(row.is_archived),
      usageCount: row.usage_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function rowToItemDto(row) {
    if (!row) {
      return null;
    }

    const unitConversionRows = await all(
      `
      SELECT
        item_unit_conversions.unit_id,
        item_unit_conversions.factor_to_primary,
        units.name AS unit_name,
        units.symbol AS unit_symbol
      FROM item_unit_conversions
      INNER JOIN units ON units.id = item_unit_conversions.unit_id
      WHERE item_unit_conversions.item_id = ?
      ORDER BY LOWER(units.name) ASC, LOWER(units.symbol) ASC
      `,
      [row.id],
    );
    const propertySchema = await getItemPropertySchema(row.id);
    // Enhancement 2.3 — combination groups this item additionally belongs to
    // (distinct from its primary hierarchical group_id). Empty for most items.
    const combinationGroupRows = await all(
      `
      SELECT group_item_memberships.group_id
      FROM group_item_memberships
      INNER JOIN groups ON groups.id = group_item_memberships.group_id
      WHERE group_item_memberships.item_id = ?
        AND groups.group_structure = 'combination'
        AND groups.is_archived = 0
      ORDER BY group_item_memberships.sort_order ASC
      `,
      [row.id],
    );
    const attachmentRows = await all(
      'SELECT id, label, object_key, file_name FROM item_attachments WHERE item_id = ? ORDER BY position ASC, id ASC',
      [row.id],
    );
    const machineLinkRows = await all(
      `
      SELECT machines.id, machines.name, machines.asset_id, machines.primary_photo_url,
             machines.machine_make, machines.manufactured_year, machines.feeder_make,
             machines.running_hours, machines.strokes_per_minute,
             machines.capacity_kind, machines.capacity_kgf, machines.die_feed_type,
             machines.group_id, machine_groups.name AS machine_group_name
      FROM item_machines
      INNER JOIN machines ON machines.id = item_machines.machine_id
      LEFT JOIN groups machine_groups ON machine_groups.id = machines.group_id
      WHERE item_machines.item_id = ?
      ORDER BY LOWER(machines.name) ASC
      `,
      [row.id],
    );
    const dieLinkRows = await all(
      `
      SELECT dies.id, dies.tool_code, dies.photo_urls,
             dies.die_type, dies.die_type_label, dies.made_by, dies.die_maker_id,
             dies.po_at, dies.date_in_at,
             dies.liner_size_nm, dies.liner_size_unit, dies.no_of_set,
             dies.number_of_cavities,
             dies.store_area, dies.rack_no
      FROM item_dies
      INNER JOIN dies ON dies.id = item_dies.die_id
      WHERE item_dies.item_id = ?
      ORDER BY LOWER(dies.tool_code) ASC
      `,
      [row.id],
    );

    return {
      id: row.id,
      name: row.name || '',
      alias: row.alias || '',
      shortCode: row.short_code || '',
      // The number this part was issued and the code derived from it. Null and
      // '' mean never stamped — most of the catalogue predates them.
      partNo: row.part_no == null ? null : Number(row.part_no),
      partCode: row.part_code || '',
      displayName: row.display_name || '',
      quantity: Number(row.quantity || 0),
      groupId: row.group_id || null,
      unitId: row.unit_id || null,
      unitConversions: unitConversionRows.map((entry) => ({
        unitId: entry.unit_id || 0,
        unitName: entry.unit_name || '',
        unitSymbol: entry.unit_symbol || '',
        factorToPrimary: Number(entry.factor_to_primary || 1),
      })),
      namingFormat: (() => {
        try {
          return row.naming_format ? JSON.parse(row.naming_format) : [];
        } catch (e) {
          return [];
        }
      })(),
      isArchived: Boolean(row.is_archived),
      usageCount: row.usage_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      variationTree: await getItemVariationTree(row.id),
      propertySchema,
      baseItemId: row.base_item_id || null,
      combinationGroupIds: combinationGroupRows.map((entry) => entry.group_id),
      photoUrl: row.photo_url || null,
      cadFileKey: row.cad_file_key || '',
      cadFileName: row.cad_file_name || '',
      attachments: attachmentRows.map((entry) => ({
        id: entry.id,
        label: entry.label || '',
        objectKey: entry.object_key || '',
        fileName: entry.file_name || '',
      })),
      // The whole sheet per machine, for the same reason as the dies below: a
      // part runs on several, and the screen listing them has to show what tells
      // them apart — the type, the make, the tonnage, the strokes.
      machines: machineLinkRows.map((entry) => ({
        id: String(entry.id),
        name: entry.name || '',
        assetId: entry.asset_id || '',
        photoUrl: entry.primary_photo_url || null,
        groupId: entry.group_id || null,
        machineType: entry.machine_group_name || '',
        machineMake: entry.machine_make || '',
        manufacturedYear:
          entry.manufactured_year == null ? null : Number(entry.manufactured_year),
        feederMake: entry.feeder_make || '',
        runningHours: entry.running_hours == null ? null : Number(entry.running_hours),
        strokesPerMinute:
          entry.strokes_per_minute == null ? null : Number(entry.strokes_per_minute),
        capacityKind: entry.capacity_kind || '',
        capacityKgf: entry.capacity_kgf == null ? null : Number(entry.capacity_kgf),
        dieFeedType: entry.die_feed_type || '',
      })),
      // The whole sheet per die, not just the code: a part can hold several, and
      // the screen that lists them has to show what tells them apart — the type,
      // the maker, the size, which rack. Columns on a join that was already
      // happening, so listing them costs nothing extra, the same discipline
      // developedFor follows.
      dies: dieLinkRows.map((entry) => {
        const urls = parseJson(entry.photo_urls, []);
        return {
          id: String(entry.id),
          toolCode: entry.tool_code || '',
          photoUrl: urls.length > 0 ? urls[0] : null,
          dieType: entry.die_type || '',
          // Both carried so a die corrected from beside its part does not send
          // back a bare slug and no maker — the upsert would store exactly that.
          dieTypeLabel: entry.die_type_label || '',
          madeBy: entry.made_by || '',
          dieMakerId: entry.die_maker_id == null ? null : Number(entry.die_maker_id),
          poAt: entry.po_at || null,
          dateInAt: entry.date_in_at || null,
          linerSizeNm: entry.liner_size_nm == null ? null : Number(entry.liner_size_nm),
          linerSizeUnit: entry.liner_size_unit || 'mm',
          noOfSet: entry.no_of_set == null ? null : Number(entry.no_of_set),
          numberOfCavities:
            entry.number_of_cavities == null ? null : Number(entry.number_of_cavities),
          storeArea: entry.store_area || '',
          rackNo: entry.rack_no || '',
        };
      }),
      developedFor: developedForDto(row),
      // How the part's item sheet is nested (057); null = the default chain.
      sectionTree: (() => {
        if (!row.section_tree_json) return null;
        try {
          return JSON.parse(row.section_tree_json);
        } catch (_) {
          return null;
        }
      })(),
      // Kept as aliases of the block above: the local replica has these two
      // cached in payloads it already wrote, and an older client still reads them.
      developedForClientId: row.developed_for_client_id || null,
      developedForClientName: row.developed_for_client_name || '',
      availableForPurchase: Boolean(row.available_for_purchase),
      // null until a sample run is recorded on this specific item.
      penPaperBaseline: parseJson(row.pen_paper_baseline_json, null),
      blankWidthMm: Number(row.blank_width_mm || 0),
      blankHeightMm: Number(row.blank_height_mm || 0),
      defaultPipelineId: row.default_pipeline_id || null,
      defaultPipelineName: row.default_pipeline_name
        || (row.default_pipeline_id ? (await desk.ask('pipelines.templates.row', { id: row.default_pipeline_id })).row?.name || null : null),
    };
  }

  return { rowToGroupDto, rowToItemDto };
}

module.exports = { createDto };
