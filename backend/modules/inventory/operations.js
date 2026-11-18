'use strict';

// ---------------------------------------------------------------------------
// Inventory — what the module offers at the kernel desk.
//
//   offered to users
//     inventory.sets.list · .create · .update · .delete
//     inventory.materials.list · .get · .detail · .activity
//     inventory.materials.createParent · .createChild · .update · .delete
//     inventory.materials.setGroupConfig · .linkGroup · .linkItem · .unlink
//     inventory.materials.scan · .resetScan
//     inventory.stock.list · .sources · inventory.health
//     inventory.movements.record
//
//   internal — asked by other modules
//     inventory.units.usageCounts     how many materials name each unit
//     inventory.movements.* · .receipts.* · .sets.* · .sources.* · .scans.*
//     inventory.ledger.* · .materials.rowByBarcode · .governance.*
//
// The second group is ./ports.js behind names, listed in ./asks.js with what
// each is for and which of them must run inside the caller's transaction. A
// module reaches them through ./client.js. Each answers `{ ok, value }` with
// whatever the port returned; a refusal the service throws is left to throw,
// because the caller is code inside a transaction of its own.
//
// Each user operation asks for the permission its route always named. One is
// not what the path suggests: applying a movement is a POST, which the gate
// calls a create, and the route also asks for `inventory.update`; a caller
// needs both, as before.
//
// The work is ./work.js: what the handlers did, returning the status and body
// they used to send. A request's path values are named (`id`, `barcode`),
// its query travels under `query` and its body under `data`; a material's
// and a movement's payloads are large and are checked by the service.
// ---------------------------------------------------------------------------

const { runMoved, operationsFromAsks, joinOperations } = require('../../kernel/desk-kit');
const ASKS = require('./asks');

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

module.exports = function inventoryOperations({ all, work, ports }) {
  // joinOperations refuses two with one name: a user operation and an internal
  // one once shared a name here, and the later silently replaced the earlier.
  return joinOperations(
    operationsFromAsks('inventory', ASKS, ports),
    userOperations({ all, work }),
  );
};

function userOperations({ all, work }) {
  return {

    'inventory.sets.list': {
      permission: 'inventory.read',
      summary: 'Every set, with its lines and its group.',
      input: { fields: { query: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.listSets, ctx, { query: input.query || {} }),
    },

    'inventory.sets.create': {
      permission: 'inventory.create',
      summary: 'Define a set: a quantified list of items.',
      input: { fields: { data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.createSet, ctx, { body: input.data }),
    },

    'inventory.sets.update': {
      permission: 'inventory.update',
      summary: 'Change a set (a full replace of its lines). With expectedVersion, refused if it moved on (code set_changed).',
      input: { fields: { id: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.updateSet, ctx, { params: { id: input.id }, body: input.data }),
    },

    'inventory.sets.delete': {
      permission: 'inventory.delete',
      summary: 'Remove a set and its links. Permanent.',
      input: { fields: { id: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.deleteSet, ctx, { params: { id: input.id }, body: input.data }),
    },

    'inventory.stock.list': {
      permission: 'inventory.read',
      summary: 'Stock by item and variation.',
      input: { fields: { query: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.stock, ctx, { query: input.query || {} }),
    },

    'inventory.stock.sources': {
      permission: 'inventory.read',
      summary: 'The barcodes that hold free stock of an item and variation, and a proposed split of a quantity over them.',
      input: { fields: { query: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.stockSources, ctx, { query: input.query || {} }),
    },

    'inventory.materials.list': {
      permission: 'inventory.read',
      summary: 'Every material.',
      input: { fields: { query: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.listMaterials, ctx, { query: input.query || {} }),
    },

    'inventory.health': {
      permission: 'inventory.read',
      summary: 'The inventory summary tiles.',
      input: { fields: { query: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.health, ctx, { query: input.query || {} }),
    },

    'inventory.materials.get': {
      permission: 'inventory.read',
      summary: 'One material, with its group configuration.',
      input: { fields: { barcode: { type: 'any', required: true }, query: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.getMaterial, ctx, { params: { barcode: input.barcode }, query: input.query || {} }),
    },

    'inventory.materials.detail': {
      permission: 'inventory.read',
      summary: 'A material’s life story: where it came from, what took it, what is nested under it.',
      input: { fields: { barcode: { type: 'any', required: true }, query: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.materialDetail, ctx, { params: { barcode: input.barcode }, query: input.query || {} }),
    },

    'inventory.materials.createParent': {
      permission: 'inventory.create',
      summary: 'A parent material and its children.',
      input: { fields: { data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.createParent, ctx, { body: input.data }),
    },

    'inventory.materials.createChild': {
      permission: 'inventory.create',
      summary: 'One more child under a parent.',
      input: { fields: { barcode: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.createChild, ctx, { params: { barcode: input.barcode }, body: input.data }),
    },

    'inventory.materials.update': {
      permission: 'inventory.update',
      summary: 'Edit a material.',
      input: { fields: { barcode: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.updateMaterial, ctx, { params: { barcode: input.barcode }, body: input.data }),
    },

    'inventory.materials.setGroupConfig': {
      permission: 'inventory.update',
      summary: 'Set a material group’s governance: units, properties, preferences.',
      input: { fields: { barcode: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.setGroupConfig, ctx, { params: { barcode: input.barcode }, body: input.data }),
    },

    'inventory.materials.delete': {
      permission: 'inventory.delete',
      summary: 'Remove a material; a parent takes its children.',
      input: { fields: { barcode: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.deleteMaterial, ctx, { params: { barcode: input.barcode }, body: input.data }),
    },

    'inventory.materials.linkGroup': {
      permission: 'inventory.update',
      summary: 'Make a material inherit from a group.',
      input: { fields: { barcode: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.linkGroup, ctx, { params: { barcode: input.barcode }, body: input.data }),
    },

    'inventory.materials.linkItem': {
      permission: 'inventory.update',
      summary: 'Make a material inherit from an item and variation.',
      input: { fields: { barcode: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.linkItem, ctx, { params: { barcode: input.barcode }, body: input.data }),
    },

    'inventory.materials.unlink': {
      permission: 'inventory.update',
      summary: 'Stop a material inheriting.',
      input: { fields: { barcode: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.unlink, ctx, { params: { barcode: input.barcode }, body: input.data }),
    },

    'inventory.materials.scan': {
      permission: 'inventory.update',
      summary: 'Count a scan of a material.',
      input: { fields: { barcode: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.scan, ctx, { params: { barcode: input.barcode }, body: input.data }),
    },

    'inventory.materials.resetScan': {
      permission: 'inventory.update',
      summary: 'Clear a material’s scan trace.',
      input: { fields: { barcode: { type: 'any', required: true }, data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.resetScan, ctx, { params: { barcode: input.barcode }, body: input.data }),
    },

    'inventory.movements.record': {
      permission: 'inventory.update',
      summary: 'Receive, issue, transfer or adjust stock. One transaction.',
      input: { fields: { data: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.applyMovement, ctx, { body: input.data }),
    },

    'inventory.materials.activity': {
      permission: 'inventory.read',
      summary: 'A material’s per-barcode activity feed.',
      input: { fields: { barcode: { type: 'any', required: true }, query: { type: 'object', nullable: true } } },
      run: (input, ctx) => runMoved(work.activity, ctx, { params: { barcode: input.barcode }, query: input.query || {} }),
    },

    // --- internal: asked by other modules ----------------------------------

    'inventory.materials.linkOf': {
      internal: true,
      summary: 'The item and variation a material stands for, by its exact barcode; or nothing.',
      input: { fields: { barcode: { type: 'any', required: true } } },
      output: { fields: { link: { type: 'object', nullable: true } } },
      run: async (input) => {
        const rows = await all(
          'SELECT linked_item_id, linked_variation_leaf_node_id FROM materials WHERE barcode = ?',
          [input.barcode],
        );
        return { ok: true, link: rows[0] || null };
      },
    },

    'inventory.movements.issuedToWorkerQty': {
      internal: true,
      summary: 'How much of a material was already issued to a worker against a job.',
      input: { fields: { barcode: { type: 'any', required: true }, referenceId: { type: 'any', required: true } } },
      output: { fields: { qty: { type: 'number', required: true } } },
      run: async (input) => {
        const rows = await all(
          `SELECT COALESCE(SUM(qty), 0) AS qty FROM inventory_movements
            WHERE material_barcode = ? AND movement_type = 'issue'
              AND reason_code = 'issued_to_worker' AND reference_id = ?`,
          [input.barcode, String(input.referenceId)],
        );
        return { ok: true, qty: Number(rows[0]?.qty || 0) };
      },
    },

    'inventory.items.usage': {
      internal: true,
      summary: 'How many materials and material-group links name an item.',
      input: { fields: { itemId: { type: 'any', required: true } } },
      output: { fields: { count: { type: 'integer', required: true, min: 0 } } },
      run: async (input) => {
        const rows = await all(
          `SELECT (SELECT COUNT(*) FROM materials WHERE linked_item_id = ?) +
                  (SELECT COUNT(*) FROM material_group_item_links WHERE item_id = ?) AS count`,
          [input.itemId, input.itemId],
        );
        return { ok: true, count: Number(rows[0]?.count || 0) };
      },
    },

    'inventory.groups.materialCount': {
      internal: true,
      summary: 'How many materials inherit from a group.',
      input: { fields: { groupId: { type: 'any', required: true } } },
      output: { fields: { count: { type: 'integer', required: true, min: 0 } } },
      run: async (input) => {
        const rows = await all('SELECT COUNT(*) AS count FROM materials WHERE linked_group_id = ?', [input.groupId]);
        return { ok: true, count: Number(rows[0]?.count || 0) };
      },
    },

    'inventory.sets.name': {
      internal: true,
      summary: 'A set’s name, or nothing when there is no such set.',
      input: { fields: { id: { type: 'any', required: true } } },
      output: { fields: { name: { type: 'string', nullable: true } } },
      run: async (input) => {
        const rows = await all('SELECT name FROM inventory_sets WHERE id = ?', [input.id]);
        return { ok: true, name: rows[0] ? rows[0].name : null };
      },
    },

    'inventory.units.usageCounts': {
      internal: true,
      summary: 'How many inventory records name each unit.',
      input: { fields: { unitId: { type: 'integer', gt: 0, nullable: true } } },
      output: { fields: { counts: { type: 'object', required: true } } },
      run: (input) => unitUsageCounts(all, input.unitId, ['materials']),
    },
  };
};
