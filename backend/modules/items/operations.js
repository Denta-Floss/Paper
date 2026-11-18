'use strict';

const { runMoved, joinOperations, operationsFromAsks } = require('../../kernel/desk-kit');
const ASKS = require('./asks');

// ---------------------------------------------------------------------------
// Items — what the module offers at the kernel desk.
//
//   offered to users
//     items.list · .get · .create · .update · .archive · .delete
//     items.moveToGroup · .setShortCode · .setSectionTree · .nextPartIdentity
//     items.sets · .usage · items.assets.* · items.photos.*
//     items.groups.list · .create · .update · .archive · .unarchive · .delete
//     items.groups.items · .addItems · .overview · .schemaImpact · .effectiveSchema
//     items.masterData.*        Master Data per item and pipeline
//     items.materialTypes.*     the material types and their densities
//     items.sheetProperties.*   the item sheet's property columns
//
//   internal — asked by other modules
//     items.rows.get · .rows.forCatalogue · items.units.usageCounts
//     items.groups.name · .row · .propertyNamesInUse
//     items.variations.node · .codeForValue
//
// WHO MAY ASK is what stood in front of each route: `items.*` by method for
// everything under /api/items, /api/groups and /api/item-sheet-properties; the
// attachment keys for a part's photos (`items.asset.list`, `items.asset.upload`);
// and, for /api/material-types and /api/pipelines/:id/master-data, which map to
// no module, a signed-in session to read and what the old write gate asks to
// change.
//
// The work is ./work.js and, for the three smaller route sets, a work function
// in their own files. A request's path values are named, its query travels
// under `query` and its body under `data`; an item's payload is checked by its
// own contract (./contract.js) at the route and again by saveItem.
//
//     and ./ports.js behind names, listed in ./asks.js: describe, lookupByName,
//     resolveSelection, selectionSnapshot, stock.*, groups.*, …
//
// A module reaches the second group through ./client.js.
// ---------------------------------------------------------------------------

/// How many of this module's records name each unit, as { unitId: count }.
/// `tables` are this module's own tables that have a unit_id column. With
/// `unitId`, only that unit is counted. The units master adds these up across
/// modules to decide whether a unit may still be changed or archived.
async function unitUsageCounts(all, unitId, tables) {
  const one = unitId != null && unitId !== '';
  const counts = {};
  for (const table of tables) {
    const rows = await all(
      `SELECT unit_id, COUNT(*) AS c FROM ${table}
        WHERE unit_id IS NOT NULL ${one ? 'AND unit_id = ?' : ''}
        GROUP BY unit_id`,
      one ? [unitId] : [],
    );
    for (const row of rows) counts[row.unit_id] = (counts[row.unit_id] || 0) + Number(row.c || 0);
  }
  return { ok: true, counts };
}

// What the old write gate asks of a POST to a path no module claims.
const OLD_WRITE_GATE = {
  anyRole: ['super_admin', 'admin'],
  anyPermission: ['config.write', 'inventory.update'],
};
const loose = { type: 'any' };

module.exports = function itemsOperations({ all, get, ports, core, masterData, materialTypes, sheetProperties }) {
  return joinOperations(
    operationsFromAsks('items', ASKS, ports),
    internalOperations({ all, get }),
    userOperations({ core, masterData, materialTypes, sheetProperties }),
  );
};

function userOperations({ core, masterData, materialTypes, sheetProperties }) {
  return {
    'items.groups.list': {
      permission: 'items.read',
      summary: 'Every group, with how many items it holds and its cover pictures.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.listGroups, ctx, { query: input.query || {}, body: input.data }),
    },

    'items.assets.uploadIntent': {
      permission: 'items.create',
      summary: 'Ask for somewhere to upload an item attachment.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.itemAssetUploadIntent, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.assets.uploadComplete': {
      permission: 'items.create',
      summary: 'Say an item attachment arrived.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.itemAssetUploadComplete, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.assets.list': {
      permission: 'items.read',
      summary: 'An item’s attachments.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.listItemAssets, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.photos.list': {
      permission: 'items.asset.list',
      summary: 'A part’s photos, in order.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.listItemPhotos, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.photos.arrange': {
      permission: 'items.asset.upload',
      summary: 'Set a part’s photos and their order.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.arrangeItemPhotos, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.sets': {
      permission: 'items.read',
      summary: 'The sets an item is in, with its quantity in each.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.itemSets, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.usage': {
      permission: 'items.read',
      summary: 'Where an item is used: orders, challans, stock.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.itemUsage, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.list': {
      permission: 'items.read',
      summary: 'Items, with usage.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.listItems, ctx, { query: input.query || {}, body: input.data }),
    },

    'items.nextPartIdentity': {
      permission: 'items.read',
      summary: 'The next part number and code for a group and set.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.nextPartIdentity, ctx, { query: input.query || {}, body: input.data }),
    },

    'items.get': {
      permission: 'items.read',
      summary: 'One item, with its variation tree.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.getItem, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.setShortCode': {
      permission: 'items.update',
      summary: 'Set an item’s short code.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.setShortCode, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.create': {
      permission: 'items.create',
      summary: 'Create an item, with its variation tree.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.createItem, ctx, { query: input.query || {}, body: input.data }),
    },

    'items.update': {
      permission: 'items.update',
      summary: 'Change an item. What is left out is kept.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.updateItem, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.setSectionTree': {
      permission: 'items.update',
      summary: 'Set how a part’s sheet sections nest, and reconcile its links.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.setSectionTree, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.archive': {
      permission: 'items.update',
      summary: 'Archive or restore an item.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.archiveItem, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.delete': {
      permission: 'items.delete',
      summary: 'Move an item to the trash.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.deleteItem, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.moveToGroup': {
      permission: 'items.update',
      summary: 'File an item under another group.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.moveItemToGroup, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.groups.create': {
      permission: 'items.create',
      summary: 'Create a group.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.createGroup, ctx, { query: input.query || {}, body: input.data }),
    },

    'items.groups.addItems': {
      permission: 'items.create',
      summary: 'File items or variants into a group.',
      input: { fields: { groupId: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.addItemsToGroup, ctx, { params: { groupId: input.groupId }, query: input.query || {}, body: input.data }),
    },

    'items.groups.items': {
      permission: 'items.read',
      summary: 'The items in a group.',
      input: { fields: { groupId: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.groupItems, ctx, { params: { groupId: input.groupId }, query: input.query || {}, body: input.data }),
    },

    'items.groups.update': {
      permission: 'items.update',
      summary: 'Change a group.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.updateGroup, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.groups.archive': {
      permission: 'items.update',
      summary: 'Archive a group.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.archiveGroup, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.groups.unarchive': {
      permission: 'items.update',
      summary: 'Restore a group.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.unarchiveGroup, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.groups.delete': {
      permission: 'items.delete',
      summary: 'Move a group to the trash.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.deleteGroup, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.groups.schemaImpact': {
      permission: 'items.read',
      summary: 'Which items a change to a group’s properties would leave without a value.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.groupSchemaImpact, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.groups.overview': {
      permission: 'items.read',
      summary: 'A group at a glance: its items, sets and stock.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.groupOverview, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.groups.effectiveSchema': {
      permission: 'items.read',
      summary: 'The properties a group’s items carry, inherited ones included.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(core.groupEffectiveSchema, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.masterData.list': {
      permission: 'items.read',
      summary: 'Every Master Data record for an item, one per pipeline.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(masterData.masterDataFor, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.masterData.resolve': {
      permission: 'items.read',
      summary: 'The Master Data that applies to an item on a pipeline, and where each value came from.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(masterData.resolveMasterData, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.masterData.save': {
      permission: 'items.update',
      summary: 'Save an item’s Master Data for a pipeline.',
      input: { fields: { id: { type: 'any', required: true }, pipelineId: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(masterData.saveMasterData, ctx, { params: { id: input.id, pipelineId: input.pipelineId }, query: input.query || {}, body: input.data }),
    },

    'items.masterData.delete': {
      permission: 'items.delete',
      summary: 'Remove an item’s Master Data for a pipeline.',
      input: { fields: { id: { type: 'any', required: true }, pipelineId: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(masterData.deleteMasterData, ctx, { params: { id: input.id, pipelineId: input.pipelineId }, query: input.query || {}, body: input.data }),
    },

    'items.masterData.forPipeline': {
      access: 'signedIn',
      summary: 'Every item’s Master Data on one pipeline.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(masterData.pipelineMasterData, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.materialTypes.list': {
      access: 'signedIn',
      summary: 'The material types, each with its density.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(materialTypes.listMaterialTypes, ctx, { query: input.query || {}, body: input.data }),
    },

    'items.materialTypes.create': {
      access: OLD_WRITE_GATE,
      summary: 'Add a material type.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(materialTypes.createMaterialType, ctx, { query: input.query || {}, body: input.data }),
    },

    'items.materialTypes.update': {
      access: OLD_WRITE_GATE,
      summary: 'Change a material type.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(materialTypes.updateMaterialType, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.materialTypes.delete': {
      access: OLD_WRITE_GATE,
      summary: 'Remove a material type.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(materialTypes.deleteMaterialType, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.sheetProperties.list': {
      permission: 'items.read',
      summary: 'The item sheet’s property columns.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(sheetProperties.listSheetProperties, ctx, { query: input.query || {}, body: input.data }),
    },

    'items.sheetProperties.create': {
      permission: 'items.create',
      summary: 'Add a property column.',
      input: { fields: { query: loose, data: loose } },
      run: (input, ctx) => runMoved(sheetProperties.createSheetProperty, ctx, { query: input.query || {}, body: input.data }),
    },

    'items.sheetProperties.update': {
      permission: 'items.update',
      summary: 'Change a property column.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(sheetProperties.updateSheetProperty, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.sheetProperties.addOption': {
      permission: 'items.create',
      summary: 'Add a value to a property column’s list.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(sheetProperties.addSheetPropertyOption, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.sheetProperties.removeOption': {
      permission: 'items.delete',
      summary: 'Remove a value no saved part carries.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(sheetProperties.removeSheetPropertyOption, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },

    'items.sheetProperties.delete': {
      permission: 'items.delete',
      summary: 'Remove a property column.',
      input: { fields: { id: { type: 'any', required: true }, query: loose, data: loose } },
      run: (input, ctx) => runMoved(sheetProperties.deleteSheetProperty, ctx, { params: { id: input.id }, query: input.query || {}, body: input.data }),
    },
  };
}

function internalOperations({ all, get }) {
  return {
    'items.groups.name': {
      internal: true,
      summary: 'A group’s name, or nothing when there is no such group.',
      input: { fields: { id: { type: 'integer', required: true, gt: 0 } } },
      output: { fields: { name: { type: 'string', nullable: true } } },
      run: async (input) => {
        const group = await get('SELECT name FROM groups WHERE id = ?', [Number(input.id)]);
        return { ok: true, name: group?.name ?? null };
      },
    },

    'items.groups.row': {
      internal: true,
      summary: 'A group’s row as stored, or nothing.',
      input: { fields: { id: { type: 'any', required: true } } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({ ok: true, row: await get('SELECT * FROM groups WHERE id = ?', [input.id]) }),
    },

    'items.groups.propertyNamesInUse': {
      internal: true,
      summary: 'The names of the live variation properties on a group’s unarchived items, as rows of name.',
      input: { fields: { groupId: { type: 'any' } } },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async (input) => ({
        ok: true,
        rows: await all(
          `SELECT DISTINCT item_variation_nodes.name AS name
             FROM item_variation_nodes
             INNER JOIN items ON items.id = item_variation_nodes.item_id
            WHERE items.group_id = ?
              AND items.is_archived = 0
              AND item_variation_nodes.kind = 'property'
              AND item_variation_nodes.is_archived = 0`,
          [Number(input.groupId)],
        ),
      }),
    },

    'items.variations.node': {
      internal: true,
      summary: 'A variation node: which item it belongs to, its kind, and whether it is archived.',
      input: { fields: { id: { type: 'any', required: true } } },
      output: { fields: { node: { type: 'object', nullable: true } } },
      run: async (input) => ({
        ok: true,
        node: await get(
          'SELECT id, item_id, kind, is_archived FROM item_variation_nodes WHERE id = ?',
          [input.id],
        ),
      }),
    },

    'items.variations.codeForValue': {
      internal: true,
      summary: 'The code of a variation value under a named property of an item, with the property’s position.',
      input: {
        fields: {
          itemId: { type: 'any', required: true },
          propertyName: { type: 'any', required: true },
          valueName: { type: 'any', required: true },
        },
      },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({
        ok: true,
        row: await get(
          `SELECT v.code, p.position
             FROM item_variation_nodes v
             JOIN item_variation_nodes p ON v.parent_node_id = p.id
            WHERE v.item_id = ? AND p.name = ? AND (v.name = ? OR v.display_name = ?)`,
          [input.itemId, input.propertyName, input.valueName, input.valueName],
        ),
      }),
    },

    'items.rows.get': {
      internal: true,
      summary: 'An item’s row as stored, or nothing.',
      input: { fields: { id: { type: 'any', required: true } } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({ ok: true, row: await get('SELECT * FROM items WHERE id = ?', [input.id]) }),
    },

    'items.rows.forCatalogue': {
      internal: true,
      summary: 'The unarchived items among these ids, as a catalogue shows them, by display name.',
      input: { fields: { ids: { type: 'array', required: true, items: { type: 'integer' } } } },
      output: { fields: { rows: { type: 'array', required: true, items: { type: 'object' } } } },
      run: async (input) => {
        const ids = (input.ids || []).map(Number).filter((id) => Number.isInteger(id));
        if (!ids.length) return { ok: true, rows: [] };
        const rows = await all(
          `SELECT id, name, display_name, alias, quantity, naming_format
             FROM items
            WHERE is_archived = 0 AND id IN (${ids.map(() => '?').join(', ')})
            ORDER BY display_name ASC`,
          ids,
        );
        return { ok: true, rows };
      },
    },

    'items.units.usageCounts': {
      internal: true,
      summary: 'How many items records name each unit.',
      input: { fields: { unitId: { type: 'integer', gt: 0, nullable: true } } },
      output: { fields: { counts: { type: 'object', required: true } } },
      run: (input) => unitUsageCounts(all, input.unitId, ['groups', 'items', 'item_unit_conversions']),
    },
  };
};
