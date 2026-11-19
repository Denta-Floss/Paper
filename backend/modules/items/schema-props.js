'use strict';

// A group's effective property schema: what the group declares, what its
// material governance adds (asked of inventory at the desk), and what is
// persisted per item.
//
// A factory: `deps` is what server.js still owns (the database helpers and
// a few shared helpers), `api` is the items service being assembled, through
// which these reach the sibling files; both are read at call time.

const { normalizeGroupPropertyDraft, normalizePropertyKey } = require('./property-keys');

function createSchemaProps(deps, api) {
  const inventoryPorts = deps.inventory;
  const { desk } = deps;
  const { all, get, parseJson, run } = deps;
  const getGroupRowById = (...args) => api.getGroupRowById(...args);

  async function getGroupMaterialRowByGroupId(groupId) {
    const normalizedGroupId = Number(groupId);
    if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) {
      return null;
    }
    // The material is inventory's; it is asked for.
    return (await desk.ask('inventory.materials.firstForGroup', { groupId: normalizedGroupId })).row;
  }

  async function getItemPropertySchema(itemId) {
    const normalizedItemId = Number(itemId);
    if (!Number.isInteger(normalizedItemId) || normalizedItemId <= 0) {
      return [];
    }
    const rows = await all(
      `
      SELECT *
      FROM item_property_schema
      WHERE item_id = ?
      ORDER BY sort_order ASC, id ASC
      `,
      [normalizedItemId],
    );
    return rows.map((row) => ({
      propertyKey: row.property_key || '',
      displayName: row.display_name || '',
      inputType: row.input_type || 'Text',
      mandatory: Number(row.mandatory || 0) === 1,
      unitId: row.unit_id ? Number(row.unit_id) : null,
      unitSymbol: row.unit_symbol || null,
      unitLabel: row.unit_label || null,
      sourceType: row.source_type || 'manual',
      sourceGroupId: row.source_group_id ? Number(row.source_group_id) : null,
      sourceGroupName: row.source_group_name || null,
      sourceItemIds: parseJson(row.source_item_ids_json, [])
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0),
      sortOrder: Number(row.sort_order || 0),
    }));
  }

  async function persistItemPropertySchema(itemId, propertySchema, now = new Date().toISOString()) {
    await run('DELETE FROM item_property_schema WHERE item_id = ?', [itemId]);
    const seen = new Set();
    const normalizedEntries = (Array.isArray(propertySchema) ? propertySchema : [])
      .map((entry) => ({
        propertyKey: normalizePropertyKey(entry?.propertyKey || entry?.displayName || ''),
        displayName: String(entry?.displayName || '').trim(),
        inputType: String(entry?.inputType || 'Text').trim() || 'Text',
        mandatory: Boolean(entry?.mandatory),
        unitId: Number(entry?.unitId),
        unitSymbol: String(entry?.unitSymbol || '').trim() || null,
        unitLabel: String(entry?.unitLabel || '').trim() || null,
        sourceType: ['inherited_item', 'inherited_group', 'manual'].includes(entry?.sourceType)
          ? entry.sourceType
          : 'manual',
        sourceGroupId: Number(entry?.sourceGroupId),
        sourceGroupName: String(entry?.sourceGroupName || '').trim() || null,
        sourceItemIds: [...new Set(
          (Array.isArray(entry?.sourceItemIds) ? entry.sourceItemIds : [])
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0),
        )],
        sortOrder: Number(entry?.sortOrder || 0),
      }))
      .filter((entry) => entry.propertyKey && entry.displayName)
      .filter((entry) => {
        if (seen.has(entry.propertyKey)) {
          return false;
        }
        seen.add(entry.propertyKey);
        return true;
      });

    for (let index = 0; index < normalizedEntries.length; index += 1) {
      const entry = normalizedEntries[index];
      await run(
        `
        INSERT INTO item_property_schema (
          item_id, property_key, display_name, input_type, mandatory,
          unit_id, unit_symbol, unit_label, source_type, source_group_id,
          source_group_name, source_item_ids_json, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          itemId,
          entry.propertyKey,
          entry.displayName,
          entry.inputType,
          entry.mandatory ? 1 : 0,
          Number.isInteger(entry.unitId) && entry.unitId > 0 ? entry.unitId : null,
          entry.unitSymbol,
          entry.unitLabel,
          entry.sourceType,
          Number.isInteger(entry.sourceGroupId) && entry.sourceGroupId > 0
            ? entry.sourceGroupId
            : null,
          entry.sourceGroupName,
          JSON.stringify(entry.sourceItemIds),
          Number.isFinite(entry.sortOrder) ? entry.sortOrder : index,
          now,
          now,
        ],
      );
    }
  }

  async function getEffectiveSchema(groupId) {
    const normalizedGroupId = Number(groupId);
    if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) {
      const error = new Error('Valid groupId is required.');
      error.statusCode = 400;
      throw error;
    }

    const lineageRows = [];
    let cursor = await getGroupRowById(normalizedGroupId);
    if (!cursor) {
      const error = new Error('Group not found.');
      error.statusCode = 404;
      throw error;
    }
    // Writes refuse to create a parent cycle, but this read must not hang if one
    // ever lands in the table anyway — stop at the first repeated ancestor.
    const seenAncestorIds = new Set();
    while (cursor) {
      if (seenAncestorIds.has(cursor.id)) {
        console.warn(
          `[groups] parent cycle detected while resolving schema for group ${normalizedGroupId}; ` +
            `stopping at group ${cursor.id}`,
        );
        break;
      }
      seenAncestorIds.add(cursor.id);
      lineageRows.unshift(cursor);
      cursor = cursor.parent_group_id
        ? await getGroupRowById(Number(cursor.parent_group_id))
        : null;
    }

    const mergedByKey = new Map();
    const discardedPropertyKeys = new Set();

    for (const groupRow of lineageRows) {
      const materialRow = await getGroupMaterialRowByGroupId(groupRow.id);
      if (!materialRow) {
        continue;
      }
      const governance = await inventoryPorts.governance.get(materialRow.id);
      for (const discardedKey of governance.discardedPropertyKeys || []) {
        discardedPropertyKeys.add(normalizePropertyKey(discardedKey));
        mergedByKey.delete(normalizePropertyKey(discardedKey));
      }
      for (const rawDraft of governance.propertyDrafts || []) {
        const draft = normalizeGroupPropertyDraft(rawDraft);
        if (!draft) {
          continue;
        }
        const propertyKey = draft.propertyKey;
        if (discardedPropertyKeys.has(propertyKey)) {
          continue;
        }
        mergedByKey.set(propertyKey, {
          name: draft.displayName,
          propertyKey,
          inputType: draft.inputType,
          mandatory: draft.mandatory,
          sourceType: draft.sourceType === 'manual' ? 'inherited_group' : draft.sourceType,
          state: draft.state,
          unitId: draft.unitId,
          unitSymbol: draft.unitSymbol,
          unitLabel: draft.unitLabel,
          sourceGroupId: draft.sourceGroupId || groupRow.id,
          sourceGroupName: draft.sourceGroupName || groupRow.name || '',
          overrideLocked: draft.overrideLocked,
          hasTypeConflict: draft.hasTypeConflict,
          coverageCount: draft.coverageCount,
          selectedItemCountAtResolution: draft.selectedItemCountAtResolution,
          resolutionSource: draft.resolutionSource,
          sources: (Array.isArray(rawDraft.sources) ? rawDraft.sources : []).map((source) => ({
            itemId: Number(source.itemId),
            itemName: source.itemName || null,
          })),
        });
      }
    }

    // Retired fields are still part of the group's history — items may hold
    // values for them — but they are not what the group asks for any more, so
    // they are reported separately instead of in the active field list.
    const allDrafts = [...mergedByKey.values()];
    const activeDrafts = allDrafts.filter((draft) => draft.state !== 'retired');
    const retiredDrafts = allDrafts.filter((draft) => draft.state === 'retired');

    return {
      groupId: normalizedGroupId,
      propertyDrafts: activeDrafts,
      retiredPropertyDrafts: retiredDrafts,
      discardedPropertyKeys: [...discardedPropertyKeys],
      lineageGroupIds: lineageRows.map((row) => Number(row.id)),
      lineageGroupNames: lineageRows.map((row) => row.name || ''),
    };
  }

  return { getGroupMaterialRowByGroupId, getItemPropertySchema, persistItemPropertySchema, getEffectiveSchema };
}

module.exports = { createSchemaProps };
