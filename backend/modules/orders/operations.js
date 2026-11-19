'use strict';

const F = require('../../kernel/fields');

// ---------------------------------------------------------------------------
// Orders — what the module offers at the kernel desk.
//
// Two kinds of operation:
//
//   offered to users (and so to the HTTP routes)
//     orders.list · orders.get · orders.save · orders.edit
//     orders.lifecycle.set · orders.delete
//
//   internal — what another module may ask, never a user
//     orders.clients.*   how many lines name a client
//     orders.lines.*     what an order line is, for production and inventory
//     orders.portal.*    the two writes the B2B portal places an order with
//
// The internal ones are ./ports.js behind a name. A caller used to be handed
// the ports object by server.js; now it asks the desk, which refuses any
// module that has not declared the name it is asking for.
//
// The service throws for a refusal (an Error carrying statusCode). An
// operation offered to users turns that into a result, so no door has to know
// which errors are refusals. Internal operations let it throw: their callers
// are code, run inside transactions of their own, and want the original error.
//
// Purchase-order document uploads are not here yet. They are mostly S3
// presigning and stay with the routes for now.
// ---------------------------------------------------------------------------

const { refusing } = require('../../kernel/desk-kit');

/// "a, b" and ["a", "b"] are the same list. A query string sends the first,
/// a module the second.
function toList(value) {
  return String(Array.isArray(value) ? value.join(',') : value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/// Who a write is recorded against in the order's activity log.
function authorOf(ctx) {
  const actor = ctx.actor || {};
  if (actor.kind === 'user') {
    return {
      id: actor.user?.id || null,
      name: actor.user?.name || 'System',
      role: actor.user?.role || 'system',
      source: 'api',
    };
  }
  return {
    id: null,
    name: 'System',
    role: 'system',
    source: actor.kind === 'module' ? `module:${actor.name}` : 'system',
  };
}

// A line id from the path. Until 2026-11-19 this was loose, so that an id
// that is not a number was answered "Order not found"; it is now refused as
// not an integer, like every other module's ids.
const id = F.id;
// A filter list may arrive as an array or as a comma-separated string; toList
// below takes both. The one place the contract says nothing about the type.
const idsOrCsv = { type: 'any' };
const save = F.obj({
  orderNo: F.text, clientId: F.int, subContractorId: F.int, clientName: F.text, poNumber: F.text,
  clientCode: F.text, itemId: F.int, itemName: F.text, variationLeafNodeId: F.int,
  variationPathLabel: F.text, variationPathNodeIds: F.list(F.int), customVariationValues: F.none,
  quantity: F.num, unitId: F.int, unitName: F.text, unitSymbol: F.text, unitPrice: F.num,
  totalInvoicedQty: F.num, status: F.text, startDate: F.text, endDate: F.text,
  poDocumentIds: F.list(F.int), materialRequirements: F.list(F.none),
  sourceSetId: F.int, sourceSetName: F.text, sourceSetMultiplier: F.num,
}).fields;
const edit = F.obj({
  orderNo: F.text, clientId: F.int, clientName: F.text, clientCode: F.text, itemId: F.int,
  itemName: F.text, variationLeafNodeId: F.int, variationPathLabel: F.text, quantity: F.num,
  unitPrice: F.num, hsnCode: F.text, cgstRate: F.num, sgstRate: F.num, cgstAmount: F.num,
  sgstAmount: F.num, taxableValue: F.num,
}).fields;

module.exports = function orderOperations({ service, ports, lineWrites }) {
  return {
    // --- offered to users --------------------------------------------------

    'orders.list': {
      permission: 'orders.read',
      summary: 'Order lines. Narrowing and paging are opt-in: no limit means every line.',
      input: {
        fields: { search: F.text, clientId: F.int, statuses: idsOrCsv, ids: idsOrCsv, limit: F.int, offset: F.int },
      },
      run: async (input) => {
        // A request with no `limit` gets every order — several features
        // legitimately need the whole set (the production order picker, challan
        // order-selection, a client's history), and a default page size would
        // silently truncate them.
        const limit = Number(input.limit || 0) || null;
        const offset = Number(input.offset || 0) || 0;
        const filter = {
          search: String(input.search || '').trim(),
          clientId: Number(input.clientId || 0) || null,
          statuses: toList(input.statuses),
          // Passed through unparsed: buildOrderFilter has to be able to tell "no
          // ids asked for" from "ids asked for that do not parse".
          ids: toList(input.ids),
        };
        const rows = await service.getOrders({ ...filter, limit, offset });
        // Counted only when paging, so the unpaged path costs exactly what it did.
        const total = limit ? await service.countOrders(filter) : rows.length;
        return {
          ok: true,
          orders: rows.map(service.rowToOrderDto),
          total,
          limit,
          offset,
          // Stated rather than inferred from a short page: "this is everything"
          // and "this is all that fits" must not look the same to a caller.
          hasMore: limit ? offset + rows.length < total : false,
        };
      },
    },

    'orders.get': {
      permission: 'orders.read',
      summary: 'One order line, shaped exactly like a row of the list.',
      input: { fields: { id } },
      run: async (input) => {
        const row = await service.getOrderRowById(input.id);
        if (!row) return { ok: false, status: 404, error: 'Order not found.' };
        return { ok: true, order: service.rowToOrderDto(row) };
      },
    },

    'orders.save': {
      permission: 'orders.create',
      summary: 'Add an order line, or merge the quantity into a matching one.',
      // The service reads and checks every field itself, and says what is wrong
      // in words a person can act on.
      input: { fields: save },
      run: (input, ctx) =>
        refusing(async () => {
          const result = await service.saveOrder(
            { ...input, actor: authorOf(ctx) },
            { returnMeta: true },
          );
          return {
            ok: true,
            order: service.rowToOrderDto(result.orderRow),
            merged: result.merged,
            quantityBefore: result.quantityBefore,
            quantityAdded: result.quantityAdded,
            quantityAfter: result.quantityAfter,
          };
        }),
    },

    'orders.edit': {
      permission: 'orders.update',
      summary: 'Change fields of an order line. Answers with the raw row.',
      input: { fields: { id, ...edit } },
      run: (input) => {
        const { id: orderId, ...updates } = input;
        return refusing(() => lineWrites.editOrderLine(Number(orderId), updates));
      },
    },

    'orders.lifecycle.set': {
      permission: 'orders.update',
      summary: 'Move a line along its lifecycle, or set its start and end dates.',
      input: { fields: { id, status: F.text, startDate: F.text, endDate: F.text } },
      run: (input, ctx) =>
        refusing(async () => {
          const order = await service.updateOrderLifecycle({
            ...input,
            id: Number(input.id),
            actor: authorOf(ctx),
          });
          return { ok: true, order: service.rowToOrderDto(order) };
        }),
    },

    'orders.delete': {
      permission: 'orders.delete',
      summary: 'Remove a line, dissolve its runs and put the stock they consumed back.',
      input: { fields: { id, wipBarcode: F.text, wipQty: F.num } },
      run: (input, ctx) =>
        refusing(() =>
          lineWrites.deleteOrderLine({
            orderId: Number(input.id),
            actorName: authorOf(ctx).name,
            wipBarcode: input.wipBarcode,
            wipQty: Number(input.wipQty || 0),
          }),
        ),
    },

    // --- internal: asked by other modules ----------------------------------

    'orders.clients.lineCount': {
      internal: true,
      summary: 'How many order lines name this client.',
      input: { fields: { clientId: F.int } },
      run: async (input) => ({ ok: true, count: await ports.clientLineCount(input.clientId) }),
    },

    'orders.clients.lineCounts': {
      internal: true,
      summary: 'Line counts for every client that has any, keyed by client id.',
      run: async () => ({
        ok: true,
        counts: Object.fromEntries(await ports.clientLineCounts()),
      }),
    },

    'orders.clients.lockedLineCount': {
      internal: true,
      summary: 'How many of this client’s lines are in progress, completed or delayed.',
      input: { fields: { clientId: F.int } },
      run: async (input) => ({
        ok: true,
        count: await ports.clientLockedLineCount(input.clientId),
      }),
    },

    'orders.lines.get': {
      internal: true,
      summary: 'Which item and variation an order line is for.',
      input: { fields: { orderItemId: F.int } },
      run: async (input) => ({ ok: true, line: await ports.lines.row(input.orderItemId) }),
    },

    'orders.lines.summary': {
      internal: true,
      summary: 'An order line with its order number and client name.',
      input: { fields: { orderItemId: F.int } },
      run: async (input) => ({ ok: true, summary: await ports.lines.summary(input.orderItemId) }),
    },

    'orders.lines.idsForOrderNo': {
      internal: true,
      summary: 'The ids of every line on an order.',
      input: { fields: { orderNo: F.text } },
      run: async (input) => ({ ok: true, ids: await ports.lines.idsForOrderNo(input.orderNo) }),
    },

    'orders.lines.idsForItem': {
      internal: true,
      summary: 'The ids of every order line for an item.',
      input: { fields: { itemId: F.int } },
      run: async (input) => ({ ok: true, ids: await ports.lines.idsForItem(input.itemId) }),
    },

    'orders.lines.customVariationValues': {
      internal: true,
      summary: 'Custom variation values typed on an item and variation’s order lines.',
      input: { fields: { itemId: F.int, variationLeafNodeId: F.int } },
      run: async (input) => ({
        ok: true,
        rows: await ports.customVariationValueRows(input.itemId, input.variationLeafNodeId),
      }),
    },

    'orders.rows.get': {
      internal: true,
      summary: 'An order line as the list shows it, with its derived status; or nothing.',
      input: { fields: { id: F.id } },
      output: { fields: { row: { type: 'object', nullable: true } } },
      run: async (input) => ({ ok: true, row: await service.getOrderRowById(input.id) }),
    },

    'orders.rows.byIds': {
      internal: true,
      summary: 'These order lines as stored, newest first.',
      input: { fields: { ids: { type: 'array', required: true } } },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async (input) => ({ ok: true, rows: await ports.rowsByIds(input.ids) }),
    },

    'orders.rows.forOrderNo': {
      internal: true,
      summary: 'Every line of an order as stored, in the order they were added.',
      input: { fields: { orderNo: F.key } },
      output: { fields: { rows: { type: 'array', required: true } } },
      run: async (input) => ({ ok: true, rows: await ports.rowsForOrderNo(input.orderNo) }),
    },

    'orders.lifecycle.move': {
      internal: true,
      summary: 'Move a line along its lifecycle for another module. A step the lifecycle forbids throws.',
      input: {
        fields: {
          id: F.id,
          status: { type: 'string', required: true },
          actor: { type: 'object', nullable: true },
        },
      },
      run: async (input) => {
        await service.updateOrderLifecycle({ id: input.id, status: input.status, actor: input.actor });
        return { ok: true };
      },
    },

    'orders.items.usage': {
      internal: true,
      summary: 'How many order lines and material requirements name an item.',
      input: { fields: { itemId: F.id } },
      output: { fields: { count: { type: 'integer', required: true, min: 0 } } },
      run: (input) => ports.itemUsage(input.itemId),
    },

    'orders.items.demand': {
      internal: true,
      summary: 'How many order lines name an item, and the quantity they add up to.',
      input: { fields: { itemId: F.id } },
      output: {
        fields: {
          lines: { type: 'integer', required: true, min: 0 },
          quantity: { type: 'number', required: true },
        },
      },
      run: (input) => ports.itemDemand(input.itemId),
    },

    'orders.units.usageCounts': {
      internal: true,
      summary: 'How many order lines and material requirements name each unit.',
      input: { fields: { unitId: { type: 'integer', gt: 0, nullable: true } } },
      output: { fields: { counts: { type: 'object', required: true } } },
      run: (input) => ports.unitUsageCounts(input.unitId),
    },

    'orders.portal.insertHeader': {
      internal: true,
      summary: 'The header row a portal order’s lines hang off.',
      input: { fields: { orderNo: F.text, clientId: F.int } },
      run: async (input) => {
        await ports.insertOrderHeader({ orderNo: input.orderNo, clientId: input.clientId });
        return { ok: true };
      },
    },

    'orders.portal.saveLine': {
      internal: true,
      summary: 'Save one line inside the caller’s transaction (it opens none of its own).',
      input: { fields: { line: { type: 'object', required: true } } },
      run: async (input) => {
        await ports.saveOrder(input.line, { returnMeta: false, useTransaction: false });
        return { ok: true };
      },
    },
  };
};

module.exports.toList = toList;
