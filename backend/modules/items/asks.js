'use strict';

// ---------------------------------------------------------------------------
// What other modules ask of items, written down once. See the note on ASKS in
// kernel/desk-kit.js: ./operations.js publishes each as an internal operation
// `items.<port>`, and ./client.js gives a caller an object shaped like
// ./ports.js that asks the desk.
//
// The functions behind them are still defined in server.js; ./ports.js counts
// each call, and /api/kernel/territory shows the counts.
// ---------------------------------------------------------------------------

module.exports = [
  // What an item is.
  { port: 'describe', args: ['id'],
    summary: 'An item as the app shows it, or nothing.' },
  { port: 'lookupByName', args: ['name'],
    summary: 'The item with exactly this name, whatever its case; or nothing.' },
  { port: 'resolveSelection', args: ['selection'],
    summary: 'Which variation of an item a line means: its leaf, path and label. Refuses a selection the item does not have.' },
  { port: 'selectionSnapshot', args: ['itemId', 'variationLeafNodeId'],
    summary: 'An item and one of its variations as a line records them.' },
  { port: 'bom.lines', args: ['itemId'],
    summary: 'An item’s bill-of-material lines.' },
  { port: 'developedForCount', args: ['clientId'],
    summary: 'How many parts were developed for a client.' },

  // An item's stock by variation. Every module that moves stock does so inside
  // a transaction it opened, so the write joins the caller's.
  { port: 'stock.assertLeaf', args: ['itemId', 'variationLeafNodeId'],
    summary: 'Refuse a variation an item’s stock cannot be kept under.' },
  { port: 'stock.applyDelta', args: ['delta'], joins: true,
    summary: 'Add to or take from an item’s stock under one variation. The one write path.' },
  { port: 'stock.holdsWholeItemStock', args: ['itemId'],
    summary: 'Whether an item has no variations, so its stock is one figure.' },
  { port: 'variationStockRows', args: [],
    summary: 'Every stock row, by item then variation.' },

  // Groups, for inventory (a material inherits from one) and for settling a
  // challan (leftover and scrap are filed under made-to-order groups).
  { port: 'groups.rowById', args: ['id'],
    summary: 'A group with its unit and usage, or nothing.' },
  { port: 'groups.save', args: ['group'], joins: true,
    summary: 'Create or change a group.' },
  { port: 'groups.ensureReconcilePrimary', args: [], joins: true,
    summary: 'The primary group settled stock is filed under, made if missing.' },
  { port: 'groups.ensureReconcileSub', args: ['name', 'parentGroupId', 'unitId'], joins: true,
    summary: 'A named group under it, made if missing.' },
  { port: 'ensureForReconcile', args: ['name', 'groupId', 'unitId', 'options'], joins: true,
    summary: 'A named item in such a group, made if missing.' },

  // The action centre.
  { port: 'delete', as: 'deleteWithCascade', args: ['type', 'id', 'by'],
    summary: 'Remove an item or a group with everything that hangs off it. `by` says who.' },
];
