'use strict';

// ---------------------------------------------------------------------------
// Challans module — ports (kernel rule K5).
//
// The only sanctioned surface through which other modules read challans
// territory. Mirrors modules/items/ports.js: named, metered, swappable.
//
// BATCH BY DEFAULT. The inbound reaches these replace were sub-SELECTs
// embedded in other modules' list queries (orders' delivered quantity, vendors'
// challan counts). Replacing an embedded sub-SELECT with a per-row port call
// turns one query into N+1 on a hot list endpoint, so the primary shape here is
// "give me the answer for THESE ids" returning a Map. Single-id helpers are
// thin wrappers over the batch form, never the other way round.
//
// Port surface:
//   delivery.qtyByOrderItems(ids)  -> Map<orderItemId, deliveredQty>
//   delivery.qtyForOrderItem(id)   -> number
//   usage.countByVendors(ids)      -> Map<vendorId, challanCount>
//   usage.countForVendor(id)       -> number
//   reception.linesForVendor(id)   -> distinct item selections received from a
//                                     vendor (their purchase history)
// ---------------------------------------------------------------------------

function normalizeIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
}

function createChallansPorts(impl) {
  const counts = {};
  function counted(name, fn) {
    if (typeof fn !== 'function') {
      throw new Error(`challans port '${name}' has no implementation`);
    }
    counts[name] = 0;
    return (...args) => {
      counts[name] += 1;
      return fn(...args);
    };
  }

  const qtyByOrderItems = counted('delivery.qtyByOrderItems', impl.qtyByOrderItems);
  const countByVendors = counted('usage.countByVendors', impl.countByVendors);

  return {
    normalizeIds,
    delivery: {
      qtyByOrderItems,
      qtyForOrderItem: async (orderItemId) => {
        const map = await qtyByOrderItems([orderItemId]);
        return map.get(Number(orderItemId)) || 0;
      },
    },
    usage: {
      countByVendors,
      countForVendor: async (vendorId) => {
        const map = await countByVendors([vendorId]);
        return map.get(Number(vendorId)) || 0;
      },
    },
    reception: {
      // "What have we previously received from this vendor?" is a challans
      // question, not a vendors one — vendors must not read delivery_challans.
      linesForVendor: counted('reception.linesForVendor', impl.receptionLinesForVendor),
    },
    stats: () => ({ ...counts }),
  };
}

module.exports = { createChallansPorts, normalizeIds };
