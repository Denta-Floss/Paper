'use strict';

// ---------------------------------------------------------------------------
// What other modules ask of challans, written down once. See the note on ASKS
// in kernel/desk-kit.js: ./operations.js publishes each as an internal
// operation `challans.<port>`, and ./client.js gives a caller an object shaped
// like ./ports.js that asks the desk.
// ---------------------------------------------------------------------------

module.exports = [
  // Production: the internal leftover and scrap notes a stage raises, and the
  // vendor sheet a scanned tag belongs to.
  { port: 'stageNotes.find', args: ['sourceReference'],
    summary: 'The internal note a stage raised, by what it refers to; or nothing.' },
  { port: 'stageNotes.create', args: ['args'],
    summary: 'Raise an internal leftover or scrap note for a stage.' },
  { port: 'stageNotes.setQuantity', args: ['challanId', 'quantity'],
    summary: 'Change the quantity on a stage’s note.' },
  { port: 'stageNotes.remove', args: ['challanId'],
    summary: 'Remove a stage’s note.' },
  { port: 'sheets.findByCode', args: ['code'],
    summary: 'The vendor sheet a scanned tag belongs to, or nothing.' },

  // The vendor master.
  { port: 'vendorUsageCount', args: ['vendorId'],
    summary: 'How many challans name a vendor.' },
  { port: 'vendorUsageCounts', args: [], returns: 'map',
    summary: 'Challan counts for every vendor that has any.' },
  { port: 'vendorPurchaseRows', args: ['vendorId'],
    summary: 'The distinct lines a vendor has delivered on reception challans, newest first, at most 100.' },

  // Inventory.
  { port: 'numbersByIds', args: ['ids'],
    summary: 'The challan numbers for these ids, as { id: number }.' },
  { port: 'customVariationValueRows', args: ['itemId', 'variationLeafNodeId'],
    summary: 'Custom variation values typed on an item and variation’s challan lines.' },
];
