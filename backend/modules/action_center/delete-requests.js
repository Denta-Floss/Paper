'use strict';

// ---------------------------------------------------------------------------
// Delete requests, and the integrity scan the action center shows beside them.
//
// A delete request is someone asking for a record to be removed that they may
// not remove themselves. A reviewer approves (the record goes) or rejects it.
//
// Approve does what it always did, per entity type, by calling `deleters`:
//
//   material, inventory_set   inventory's ports        (no trash entry)
//   item, group               the items port             (trashed, restorable)
//   asset                     marked deleted, swept a day later
//   challan_template          raw delete after a check
//   vendor, machine, die, user  a RAW delete on the main connection
//
// That last line is a known gap, kept as it is and pinned by tests: those four
// skip the in-use checks the normal DELETE routes make, skip the trash, and are
// stopped (as a bare 500) only if a foreign key happens to refuse them. Making
// them check, or trash, is its own change.
//
// One thing is different from before the move: a request whose entity type is
// not in that list is REFUSED (400, still pending). It used to be marked
// approved while deleting nothing.
//
// The integrity scan is a read-only audit across other modules' tables: ten
// anti-joins for a foreign key whose target is gone, each run in isolation so one
// failing query is reported in scanErrors rather than stopping the rest. It keeps
// its SQL here on purpose; a port per table would be ceremony for a report.
// ---------------------------------------------------------------------------

function rowToDeleteRequestDto(r) {
  return {
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityLabel: r.entity_label,
    reason: r.reason,
    status: r.status,
    requestedByUserId: r.requested_by_user_id,
    reviewedByUserId: r.reviewed_by_user_id,
    reviewedAt: r.reviewed_at,
    reviewedNote: r.reviewed_note,
    createdAt: r.created_at
  };
}

function createDeleteRequestService({ get, all, run, deleters, parsePagination }) {
  async function listRequests(query) {
    const status = String(query.status || '').trim();
    const whereClauses = [];
    const params = [];
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      whereClauses.push('status = ?');
      params.push(status);
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { limit, offset } = parsePagination(query, { defaultLimit: 50, maxLimit: 100 });
    const countRow = await get(`SELECT COUNT(*) as count FROM delete_requests ${whereSql}`, params);
    const total = Number(countRow?.count || 0);
    const rows = await all(`SELECT * FROM delete_requests ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { requests: rows.map(rowToDeleteRequestDto), total };
  }

  async function createRequest({ entityType, entityId, entityLabel, reason }, userId) {
    if (!entityType || !entityId) {
      return { refusal: { status: 400, body: { success: false, error: 'entityType and entityId are required.' } } };
    }
    const insertResult = await run(
      `INSERT INTO delete_requests (entity_type, entity_id, entity_label, reason, status, requested_by_user_id, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [entityType, entityId, entityLabel || '', reason || '', userId, new Date().toISOString()]
    );
    const r = await get(`SELECT * FROM delete_requests WHERE id = ?`, [insertResult.lastID]);
    return { request: rowToDeleteRequestDto(r) };
  }

  /// Approve: the record goes, then the request is marked. Not atomic, as it
  /// never was: a delete that fails leaves the request pending.
  async function approve(id, { note, reviewerId, req }) {
    const reqRow = await get('SELECT * FROM delete_requests WHERE id = ?', [id]);
    if (!reqRow) return { refusal: { status: 404, body: { success: false, error: 'Not found' } } };
    if (reqRow.status !== 'pending') return { refusal: { status: 400, body: { success: false, error: 'Request is not pending.' } } };

    const deleter = Object.prototype.hasOwnProperty.call(deleters, reqRow.entity_type)
      ? deleters[reqRow.entity_type]
      : null;
    if (!deleter) {
      return {
        refusal: {
          status: 400,
          body: { success: false, error: `Cannot approve: "${reqRow.entity_type}" is not a kind of record that can be deleted from here.` },
        },
      };
    }
    await deleter(reqRow.entity_id, req);

    const now = new Date().toISOString();
    await run(
      `UPDATE delete_requests SET status = 'approved', reviewed_by_user_id = ?, reviewed_at = ?, reviewed_note = ? WHERE id = ?`,
      [reviewerId, now, note || '', id]
    );
    const r = await get('SELECT * FROM delete_requests WHERE id = ?', [id]);
    return { request: rowToDeleteRequestDto(r) };
  }

  async function reject(id, { note, reviewerId }) {
    const reqRow = await get('SELECT * FROM delete_requests WHERE id = ?', [id]);
    if (!reqRow) return { refusal: { status: 404, body: { success: false, error: 'Not found' } } };
    if (reqRow.status !== 'pending') return { refusal: { status: 400, body: { success: false, error: 'Request is not pending.' } } };

    const now = new Date().toISOString();
    await run(
      `UPDATE delete_requests SET status = 'rejected', reviewed_by_user_id = ?, reviewed_at = ?, reviewed_note = ? WHERE id = ?`,
      [reviewerId, now, note || '', id]
    );
    const r = await get('SELECT * FROM delete_requests WHERE id = ?', [id]);
    return { request: rowToDeleteRequestDto(r) };
  }

  async function exportCsv() {
    const rows = await all(`SELECT * FROM delete_requests ORDER BY created_at DESC`);
    const csvHeader = 'id,entityType,entityId,entityLabel,status,createdAt,reviewedAt\n';
    const csvBody = rows.map(r => `${r.id},${r.entity_type},${r.entity_id},${r.entity_label},${r.status},${r.created_at},${r.reviewed_at || ''}`).join('\n');
    return csvHeader + csvBody;
  }

  /// Broken foreign-key references caused by hard deletes, for the user to
  /// resolve.
  async function scanIntegrity() {
    const issues = [];
    const scanErrors = [];

    // ownerTable/ownerId → the record holding the dangling reference (drives "Resolve").
    // brokenTable/brokenId → the missing target row (drives "Revert" = restore from trash).
    function addIssue({ severity, ownerTable, ownerId, ownerLabel, brokenTable, brokenField, brokenId, brokenLabel }) {
      issues.push({
        type: 'broken_reference',
        severity,
        ownerTable,
        ownerId,
        ownerLabel,
        brokenTable,
        brokenField,
        brokenId,
        brokenLabel,
      });
    }

    // Each scan runs in isolation so one failing query (e.g. a table absent on an
    // older DB) records an error but never aborts the remaining scans.
    async function scan(label, fn) {
      try {
        await fn();
      } catch (err) {
        scanErrors.push({ scan: label, error: err.message });
        console.error(`[ActionCenter] scan "${label}" failed:`, err.message);
      }
    }

    // Items → groups
    await scan('items.group_id', async () => {
      const rows = await all(`SELECT i.id, i.name, i.display_name, i.group_id FROM items i LEFT JOIN groups g ON g.id = i.group_id WHERE i.group_id IS NOT NULL AND g.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'error', ownerTable: 'items', ownerId: r.id, ownerLabel: r.display_name || r.name || `Item #${r.id}`, brokenTable: 'groups', brokenField: 'group_id', brokenId: r.group_id, brokenLabel: `Group #${r.group_id}` });
    });

    // Items → units
    await scan('items.unit_id', async () => {
      const rows = await all(`SELECT i.id, i.name, i.display_name, i.unit_id FROM items i LEFT JOIN units u ON u.id = i.unit_id WHERE i.unit_id IS NOT NULL AND u.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'error', ownerTable: 'items', ownerId: r.id, ownerLabel: r.display_name || r.name || `Item #${r.id}`, brokenTable: 'units', brokenField: 'unit_id', brokenId: r.unit_id, brokenLabel: `Unit #${r.unit_id}` });
    });

    // Groups → parent group
    await scan('groups.parent_group_id', async () => {
      const rows = await all(`SELECT g.id, g.name, g.parent_group_id FROM groups g LEFT JOIN groups p ON p.id = g.parent_group_id WHERE g.parent_group_id IS NOT NULL AND p.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'warning', ownerTable: 'groups', ownerId: r.id, ownerLabel: r.name || `Group #${r.id}`, brokenTable: 'groups', brokenField: 'parent_group_id', brokenId: r.parent_group_id, brokenLabel: `Group #${r.parent_group_id}` });
    });

    // Groups → units
    await scan('groups.unit_id', async () => {
      const rows = await all(`SELECT g.id, g.name, g.unit_id FROM groups g LEFT JOIN units u ON u.id = g.unit_id WHERE g.unit_id IS NOT NULL AND u.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'warning', ownerTable: 'groups', ownerId: r.id, ownerLabel: r.name || `Group #${r.id}`, brokenTable: 'units', brokenField: 'unit_id', brokenId: r.unit_id, brokenLabel: `Unit #${r.unit_id}` });
    });

    // Order lines → client
    await scan('order_items.client_id', async () => {
      const rows = await all(`SELECT oi.id, oi.order_no, oi.client_id FROM order_items oi LEFT JOIN clients c ON c.id = oi.client_id WHERE oi.client_id IS NOT NULL AND c.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'error', ownerTable: 'order_items', ownerId: r.id, ownerLabel: `Order ${r.order_no || '#' + r.id}`, brokenTable: 'clients', brokenField: 'client_id', brokenId: r.client_id, brokenLabel: `Client #${r.client_id}` });
    });

    // Order lines → item
    await scan('order_items.item_id', async () => {
      const rows = await all(`SELECT oi.id, oi.order_no, oi.item_id FROM order_items oi LEFT JOIN items i ON i.id = oi.item_id WHERE oi.item_id IS NOT NULL AND i.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'error', ownerTable: 'order_items', ownerId: r.id, ownerLabel: `Order ${r.order_no || '#' + r.id}`, brokenTable: 'items', brokenField: 'item_id', brokenId: r.item_id, brokenLabel: `Item #${r.item_id}` });
    });

    // Order lines → sub-contractor
    await scan('order_items.sub_contractor_id', async () => {
      const rows = await all(`SELECT oi.id, oi.order_no, oi.sub_contractor_id FROM order_items oi LEFT JOIN sub_contractors s ON s.id = oi.sub_contractor_id WHERE oi.sub_contractor_id IS NOT NULL AND s.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'warning', ownerTable: 'order_items', ownerId: r.id, ownerLabel: `Order ${r.order_no || '#' + r.id}`, brokenTable: 'sub_contractors', brokenField: 'sub_contractor_id', brokenId: r.sub_contractor_id, brokenLabel: `Sub-contractor #${r.sub_contractor_id}` });
    });

    // Delivery challans → material-owner client
    await scan('delivery_challans.material_owner_client_id', async () => {
      const rows = await all(`SELECT dc.id, dc.challan_no, dc.material_owner_client_id FROM delivery_challans dc LEFT JOIN clients c ON c.id = dc.material_owner_client_id WHERE dc.material_owner_client_id IS NOT NULL AND c.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'error', ownerTable: 'delivery_challans', ownerId: r.id, ownerLabel: r.challan_no ? `Challan ${r.challan_no}` : `Challan #${r.id}`, brokenTable: 'clients', brokenField: 'material_owner_client_id', brokenId: r.material_owner_client_id, brokenLabel: `Client #${r.material_owner_client_id}` });
    });

    // Delivery challans → vendor
    await scan('delivery_challans.vendor_id', async () => {
      const rows = await all(`SELECT dc.id, dc.challan_no, dc.vendor_id FROM delivery_challans dc LEFT JOIN vendors v ON v.id = dc.vendor_id WHERE dc.vendor_id IS NOT NULL AND v.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'error', ownerTable: 'delivery_challans', ownerId: r.id, ownerLabel: r.challan_no ? `Challan ${r.challan_no}` : `Challan #${r.id}`, brokenTable: 'vendors', brokenField: 'vendor_id', brokenId: r.vendor_id, brokenLabel: `Vendor #${r.vendor_id}` });
    });

    // Inventory movements → item
    await scan('inventory_movements.item_id', async () => {
      const rows = await all(`SELECT m.id, m.item_id, m.movement_type FROM inventory_movements m LEFT JOIN items i ON i.id = m.item_id WHERE m.item_id IS NOT NULL AND i.id IS NULL`);
      for (const r of rows) addIssue({ severity: 'warning', ownerTable: 'inventory_movements', ownerId: r.id, ownerLabel: `${r.movement_type || 'Movement'} #${r.id}`, brokenTable: 'items', brokenField: 'item_id', brokenId: r.item_id, brokenLabel: `Item #${r.item_id}` });
    });

    return { issues, scanErrors };
  }

  return { listRequests, createRequest, approve, reject, exportCsv, scanIntegrity };
}

module.exports = { createDeleteRequestService, rowToDeleteRequestDto };
