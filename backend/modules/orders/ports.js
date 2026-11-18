'use strict';

// ---------------------------------------------------------------------------
// What other modules may ask of the orders module.
//
// Orders is still in server.js, so these are thin readers over its tables, not
// yet a boundary with a service behind it. They exist so modules that have
// already left (clients today) do not carry SQL against order_items or
// order_headers in their own files. When orders moves, this file is the
// contract it keeps; callers do not change.
//
// Counts are reads. The two writes, insertOrderHeader and saveOrder, are the
// pair the B2B portal uses to place an order and are named for that.
// ---------------------------------------------------------------------------

function createOrdersPorts({ get, all, run, saveOrder }) {
  return {
    /// How many order lines name this client.
    async clientLineCount(clientId) {
      const row = await get(
        'SELECT COUNT(*) AS c FROM order_items WHERE client_id = ?',
        [clientId],
      );
      return Number(row?.c || 0);
    },

    /// Line counts for every client that has any, as Map(clientId -> count).
    /// A client missing from the map has none.
    async clientLineCounts() {
      const rows = await all(`
        SELECT client_id, COUNT(*) AS c
        FROM order_items
        WHERE client_id IS NOT NULL
        GROUP BY client_id
      `);
      return new Map(rows.map((row) => [row.client_id, Number(row.c || 0)]));
    },

    /// How many of this client's lines are live (in progress, completed or
    /// delayed). A client with any of these keeps its name and GST number.
    async clientLockedLineCount(clientId) {
      const row = await get(
        `
        SELECT COUNT(*) AS count
        FROM order_items
        WHERE client_id = ?
          AND status IN ('inProgress', 'completed', 'delayed')
        `,
        [clientId],
      );
      return Number(row?.count || 0);
    },

    /// How many order lines and material requirements name an item.
    async itemUsage(itemId) {
      const row = await get(
        `SELECT (SELECT COUNT(*) FROM order_items WHERE item_id = ?) +
                (SELECT COUNT(*) FROM order_material_requirements WHERE item_id = ?) AS count`,
        [itemId, itemId],
      );
      return { ok: true, count: Number(row?.count || 0) };
    },

    /// These order lines as stored, newest first.
    rowsByIds(ids) {
      const wanted = (ids || []).map((id) => Number(id)).filter((id) => id > 0);
      if (wanted.length === 0) return Promise.resolve([]);
      return all(
        `SELECT * FROM order_items
          WHERE id IN (${wanted.map(() => '?').join(', ')})
          ORDER BY datetime(created_at) DESC, id DESC`,
        wanted,
      );
    },

    /// Every line of an order as stored, in the order they were added.
    rowsForOrderNo: (orderNo) =>
      all('SELECT * FROM order_items WHERE order_no = ? ORDER BY id ASC', [orderNo]),

    /// How many order lines name an item and what quantity they add up to.
    async itemDemand(itemId) {
      const row = await get(
        'SELECT COUNT(*) AS lines, COALESCE(SUM(quantity), 0) AS quantity FROM order_items WHERE item_id = ?',
        [itemId],
      );
      return { ok: true, lines: Number(row?.lines || 0), quantity: Number(row?.quantity || 0) };
    },

    /// How many order lines and material requirements name each unit, as
    /// `{ ok, counts: { unitId: n } }`; with `unitId`, only that unit.
    async unitUsageCounts(unitId = null) {
      const one = unitId != null && unitId !== '';
      const counts = {};
      for (const table of ['order_items', 'order_material_requirements']) {
        const rows = await all(
          `SELECT unit_id, COUNT(*) AS c FROM ${table}
            WHERE unit_id IS NOT NULL ${one ? 'AND unit_id = ?' : ''}
            GROUP BY unit_id`,
          one ? [unitId] : [],
        );
        for (const row of rows) counts[row.unit_id] = (counts[row.unit_id] || 0) + Number(row.c || 0);
      }
      return { ok: true, counts };
    },

    /// The custom variation values (JSON text) typed on this item and variation's
    /// order lines, for the stock overview to merge. Empty ones are left out.
    customVariationValueRows(itemId, variationLeafNodeId) {
      return all(
        `
        SELECT custom_variation_values_json
        FROM order_items
        WHERE item_id = ?
          AND COALESCE(variation_leaf_node_id, 0) = ?
          AND TRIM(COALESCE(custom_variation_values_json, '')) NOT IN ('', '{}')
        `,
        [itemId, variationLeafNodeId],
      );
    },

    /// The header row an order's lines hang off.
    insertOrderHeader({ orderNo, clientId }) {
      const now = new Date().toISOString();
      return run(
        'INSERT INTO order_headers (order_no, client_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [orderNo, clientId, now, now],
      );
    },

    /// Save one order line. The same function the orders screens use.
    saveOrder: (...args) => saveOrder(...args),

    /// Order lines, as production needs to see them: what a run was started
    /// for. Production keeps the link from a run to an order line and asks
    /// here what that line is.
    lines: {
      /// The line itself: which item and variation it is for, or undefined.
      row: (orderItemId) => get(
        'SELECT id, order_no, item_id, variation_leaf_node_id, variation_path_label FROM order_items WHERE id = ?',
        [orderItemId],
      ),

      /// The line with its order and client: `{ order_item_id, order_no,
      /// client_name }`, or undefined when the line or its order is gone.
      summary: (orderItemId) => get(
        `SELECT i.id AS order_item_id, h.order_no, c.name AS client_name
           FROM order_items i
           JOIN order_headers h ON i.order_no = h.order_no
           LEFT JOIN clients c ON h.client_id = c.id
          WHERE i.id = ?`,
        [orderItemId],
      ),

      async idsForOrderNo(orderNo) {
        const rows = await all('SELECT id FROM order_items WHERE order_no = ?', [orderNo]);
        return rows.map((row) => row.id);
      },

      async idsForItem(itemId) {
        const rows = await all('SELECT id FROM order_items WHERE item_id = ?', [itemId]);
        return rows.map((row) => row.id);
      },
    },
  };
}

module.exports = { createOrdersPorts };
