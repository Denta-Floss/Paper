'use strict';

// ---------------------------------------------------------------------------
// What other modules may ask of the inventory module.
//
// Named so that every cross-border call is greppable (`inventoryPorts.`) and so
// the calls other modules make are the whole of what inventory promises them.
// Grows with each step of the inventory move; today it is the sets.
//
//   sets.deleteById(id)             remove a set and its links (action center,
//                                   when a delete request is approved)
//   sets.removeLinesForItem(id)     an item is being deleted: drop its lines in
//                                   every set (the items module's cascade)
//   sets.membershipForItem(id)      which sets hold this item, one row per line
//                                   (the item editor's Sets card, item usage)
// ---------------------------------------------------------------------------

function createInventoryPorts({ inventory }) {
  return {
    sets: {
      deleteById: (setId) => inventory.deleteInventorySet(setId),
      removeLinesForItem: (itemId) => inventory.removeSetLinesForItem(itemId),
      membershipForItem: (itemId) => inventory.getItemSetMembership(itemId),
    },
  };
}

module.exports = { createInventoryPorts };
