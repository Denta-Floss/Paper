'use strict';

// ---------------------------------------------------------------------------
// What other modules may ask of the inventory module.
//
// Named so that every cross-border call is greppable (`inventoryPorts.`) and so
// the calls other modules make are the whole of what inventory promises them.
//
//   sets.deleteById(id)             remove a set and its links (action center,
//                                   when a delete request is approved)
//   sets.removeLinesForItem(id)     an item is being deleted: drop its lines in
//                                   every set (the items module's cascade)
//   sets.membershipForItem(id)      which sets hold this item, one row per line
//                                   (the item editor's Sets card, item usage)
//
//   materials.delete(barcode)       remove a material (action center approval)
//   governance.get(materialId)      a material's group-inheritance configuration
//                                   (the items module's effective schema)
//   governance.retireMissingProperties(args)
//                                   retire group properties a save dropped (the
//                                   items module's saveGroup)
//
//   movements.apply(payload)        THE write path into the stock ledger, in its
//                                   own transaction
//   movements.applyCore(payload, { useTransaction })
//                                   the same, for a caller that is already inside
//                                   a transaction and passes useTransaction:false
//                                   (SQLite has no nested BEGIN). Challans, orders,
//                                   production and jobs call this one.
//   scans.increment(barcode)        count a scan against a material
//   ledger.recomputeSummary(barcode, now)
//                                   re-derive a material's on-hand figures from
//                                   its stock positions
// ---------------------------------------------------------------------------

function createInventoryPorts({ inventory }) {
  return {
    sets: {
      deleteById: (setId) => inventory.deleteInventorySet(setId),
      removeLinesForItem: (itemId) => inventory.removeSetLinesForItem(itemId),
      membershipForItem: (itemId) => inventory.getItemSetMembership(itemId),
    },
    materials: {
      delete: (barcode) => inventory.deleteMaterialRecord(barcode),
    },
    governance: {
      get: (materialId) => inventory.getMaterialGroupGovernance(materialId),
      retireMissingProperties: (args) => inventory.retireMissingGroupProperties(args),
    },
    movements: {
      apply: (payload) => inventory.applyInventoryMovement(payload),
      applyCore: (payload, options) => inventory.applyInventoryMovementCore(payload, options),
    },
    scans: {
      increment: (barcode) => inventory.incrementMaterialScanCount(barcode),
    },
    ledger: {
      recomputeSummary: (barcode, now) => inventory.recomputeMaterialInventorySummary(barcode, now),
    },
  };
}

module.exports = { createInventoryPorts };
