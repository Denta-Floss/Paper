'use strict';

// ---------------------------------------------------------------------------
// What other modules may ask of the challans module.
//
// The challans code is still in server.js, so these are thin readers over its
// tables, not yet a boundary with a service behind it. They exist so that the
// modules that have already left (vendors today) do not carry SQL against
// delivery_challans in their own files. When challans moves, this file is the
// contract it has to keep; callers do not change.
//
// Read-only on purpose. A module that needs to WRITE a challan asks for a
// different, deliberate port.
// ---------------------------------------------------------------------------

function createChallansPorts({ get, all }) {
  return {
    /// How many challans name this vendor.
    async vendorUsageCount(vendorId) {
      const row = await get(
        'SELECT COUNT(*) AS c FROM delivery_challans WHERE vendor_id = ?',
        [vendorId],
      );
      return Number(row?.c || 0);
    },

    /// Challan counts for every vendor that has any, as Map(vendorId -> count).
    /// A vendor missing from the map has none.
    async vendorUsageCounts() {
      const rows = await all(`
        SELECT vendor_id, COUNT(*) AS c
        FROM delivery_challans
        WHERE vendor_id IS NOT NULL
        GROUP BY vendor_id
      `);
      return new Map(rows.map((row) => [row.vendor_id, Number(row.c || 0)]));
    },

    /// The challan numbers for these ids, as `{ id: challanNo }`. For a screen
    /// that shows which reception a piece of stock came in on.
    async numbersByIds(ids) {
      const wanted = [...new Set((ids || []).map((id) => Number(id)).filter((id) => id > 0))];
      if (wanted.length === 0) return {};
      const rows = await all(
        `SELECT id, challan_no FROM delivery_challans WHERE id IN (${wanted.map(() => '?').join(',')})`,
        wanted,
      );
      return Object.fromEntries(rows.map((row) => [row.id, row.challan_no || '']));
    },

    /// The custom variation values (JSON text) typed on this item and variation's
    /// challan lines, for the stock overview to merge. Empty ones are left out.
    customVariationValueRows(itemId, variationLeafNodeId) {
      return all(
        `
        SELECT custom_variation_values_json
        FROM delivery_challan_items
        WHERE item_id = ?
          AND COALESCE(variation_leaf_node_id, 0) = ?
          AND TRIM(COALESCE(custom_variation_values_json, '')) NOT IN ('', '{}')
        `,
        [itemId, variationLeafNodeId],
      );
    },

    /// The distinct lines this vendor has delivered to us on reception
    /// challans, newest first, capped at 100. Raw rows: the caller shapes them.
    vendorPurchaseRows(vendorId) {
      return all(`
        SELECT DISTINCT
          dci.item_id,
          dci.variation_leaf_node_id,
          dci.variation_path_label,
          dci.variation_path_node_ids_json,
          dci.custom_variation_values_json,
          dci.particulars
        FROM delivery_challans dc
        JOIN delivery_challan_items dci ON dc.id = dci.challan_id
        WHERE dc.vendor_id = ? AND dc.type = 'reception'
        ORDER BY dci.created_at DESC
        LIMIT 100
      `, [vendorId]);
    },
  };
}

module.exports = { createChallansPorts };
