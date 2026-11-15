'use strict';

const barcodes = require('../../kernel/barcodes');

// ---------------------------------------------------------------------------
// The inventory module's service.
//
// Grows as inventory leaves server.js. It holds:
//   - the SETS: what a set is made of (a bill of material with quantities), how
//     it is filed under a group, and its photo;
//   - the MATERIALS: parents and children, their barcodes and DTOs, creation,
//     edit, delete and linking to a group or an item;
//   - GROUP GOVERNANCE: the inheritance configuration a material carries for
//     the item group it is linked to;
//   - the LEDGER: scan counts, the per-barcode activity feed, stock positions,
//     the movement engine and the read models built on them.
// What is NOT here: the universal barcode resolver, the search routes, and the
// production and challans code that writes inventory tables by hand. Those move
// with their own modules.
//
// Takes {get, all, run} plus what a set needs from the modules around it, all by
// name because those modules are either still in server.js or mount later:
//
//   describeItem(itemId)                        the items port's identity card
//   resolveLinks(type, ids, targetType)         entity_links, read (mounts late)
//   writeLink(type, id, targetType, targetId)   entity_links, write (mounts late)
//   getPurgeEntityLinks()                       the cascade that clears a deleted
//                                               record's links, or null
//   itemHelpers                                 the item and variation tree readers
//                                               a set line is validated against
//   rowToUploadedAssetDto(row, withUrl)         a set's primary photo, presigned
//
// Writes that cannot be refused with a status throw an Error carrying
// statusCode (and `code` for set_changed), as saveVendor and saveClient do.
// ---------------------------------------------------------------------------

function createInventoryService({
  get,
  all,
  run,
  describeItem,
  resolveLinks,
  writeLink,
  getPurgeEntityLinks,
  itemHelpers,
  rowToUploadedAssetDto,
  // Still defined in server.js; passed by name (all are function declarations).
  parseJson,
  resolveUnitPayload,
  getUnitRowById,
  getGroupRowById,
  getItemSelectionSnapshot,
  saveGroup,
  applyVariationStockDelta,
  normalizeChallanType,
  getMaterialRowByBarcode,
  normalizeGroupPropertyDraft,
  normalizeDiscardedPropertyKeys,
  normalizePropertyKey,
  // The append-only custody ledger belongs to no module; inventory writes to it.
  recordLedgerEvent,
  // For the stock overview, which reads across four modules' tables.
  resolveLeafSelectionFromDb,
  variationStockRows,
  orders,
  challans,
}) {
  const {
    getItemVariationTree,
    activeValueSelectionForLeaf,
    buildVariationPathLabel,
    getItemRowById,
    activeTopLevelVariationProperties,
    activeChildrenForNode,
    findVariationNodeById,
    activeValuePathForLeaf,
  } = itemHelpers;

  // --- sets -----------------------------------------------------------------

  function rowToInventorySetDto(row, lines = []) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      name: row.name || '',
      totalItemCount: Number(row.total_item_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Set only for a set produced by an assembly step, so the Sets tab can say
      // where it came from instead of showing it as just another definition.
      isTemporary: Number(row.is_temporary || 0) === 1,
      originRunId: row.origin_run_id || null,
      originNodeId: row.origin_node_id || null,
      sourceSetId: row.source_set_id || null,
      producedAt: row.produced_at || null,
      // Stock the set actually holds, and the barcode its ledger lives under.
      onHandQty: row.on_hand_qty === null || row.on_hand_qty === undefined
        ? null
        : Number(row.on_hand_qty),
      materialBarcode: row.material_barcode || null,
      // The group the set is filed under, from the entity_links graph rather than
      // a column of its own — resolved by the caller and smuggled in on the row,
      // the way asset_photo_url is. groupIsArchived is reported so a display
      // surface does not present a retired group as a live one.
      groupId: row.group_id === null || row.group_id === undefined ? null : Number(row.group_id),
      groupName: row.group_name || null,
      groupIsArchived: Number(row.group_is_archived || 0) === 1,
      // The token a save is allowed to carry back (migrations/046). A caller that
      // sends the version it opened at is refused if the set moved on.
      version: Number(row.version || 0),
      // A set carries its own photo, shown on its card in the Items master.
      // Uploaded against entity_type 'inventory_set', which assets already allow.
      photoUrl: row.photo_url || row.asset_photo_url || null,
      lines,
    };
  }

  function mergeInventorySetLines(lines = []) {
    const merged = new Map();
    for (const [index, rawLine] of (Array.isArray(lines) ? lines : []).entries()) {
      const itemId = Number(rawLine?.itemId || 0);
      const variationLeafNodeId = Number(rawLine?.variationLeafNodeId || 0);
      const quantity = Math.trunc(Number(rawLine?.quantity || 0));
      const position = Number.isFinite(Number(rawLine?.position))
        ? Number(rawLine.position)
        : index;
      if (!Number.isInteger(itemId) || itemId <= 0) {
        const error = new Error(`Set line ${index + 1} requires a valid item.`);
        error.statusCode = 400;
        throw error;
      }
      if (!Number.isInteger(variationLeafNodeId) || variationLeafNodeId < 0) {
        const error = new Error(`Set line ${index + 1} requires a valid variation path.`);
        error.statusCode = 400;
        throw error;
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        const error = new Error(`Set line ${index + 1} requires quantity greater than 0.`);
        error.statusCode = 400;
        throw error;
      }
      const key = `${itemId}:${variationLeafNodeId}`;
      const existing = merged.get(key);
      merged.set(key, {
        itemId,
        variationLeafNodeId,
        quantity: (existing?.quantity || 0) + quantity,
        position: existing?.position ?? position,
      });
    }
    return [...merged.values()].sort((a, b) => a.position - b.position);
  }

  async function getInventorySetLineDtos(setId) {
    const rows = await all(
      `
      SELECT lines.*
      FROM inventory_set_lines lines
      WHERE lines.set_id = ?
      ORDER BY lines.position ASC, lines.id ASC
      `,
      [setId],
    );
    const lines = [];
    for (const row of rows) {
      const itemDesc = await describeItem(row.item_id);
      const itemTree = await getItemVariationTree(Number(row.item_id));
      const selection = activeValueSelectionForLeaf(
        itemTree,
        Number(row.variation_leaf_node_id),
      );
      lines.push({
        id: row.id,
        itemId: Number(row.item_id || 0),
        variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
        quantity: Number(row.quantity || 0),
        position: Number(row.position || 0),
        itemName: itemDesc?.name || '',
        itemDisplayName: itemDesc?.displayName || itemDesc?.name || '',
        variationPathLabel: selection ? buildVariationPathLabel(selection.segments) : 'Base item',
        variationPathNodeIds: selection?.nodeIds || [],
      });
    }
    return lines;
  }

  /// The set's primary uploaded photo, presigned for display. Null when it has
  /// none, or when presigning is unavailable — a missing picture must never fail
  /// the set fetch.
  async function inventorySetPhotoUrl(setId) {
    const asset = await get(
      `SELECT * FROM uploaded_assets
        WHERE entity_type = 'inventory_set' AND entity_id = ? AND status = 'uploaded'
        ORDER BY is_primary DESC, created_at ASC
        LIMIT 1`,
      [setId],
    );
    if (!asset) return null;
    const dto = await rowToUploadedAssetDto(asset, true);
    return dto?.readUrl || null;
  }

  // The group each of these sets is filed under, from the link graph. One call
  // for a whole list: resolving per set would be a third layer of N+1 on top of
  // the per-set detail read and the per-line item describe.
  async function inventorySetGroups(setIds) {
    return resolveLinks('set', setIds, 'group');
  }

  // Rows carry the group the way they carry asset_photo_url: resolved outside and
  // smuggled in, so rowToInventorySetDto stays a pure mapping.
  function withInventorySetGroup(row, group) {
    return {
      ...row,
      group_id: group ? group.id : null,
      group_name: group ? group.label : null,
      group_is_archived: group && group.archived ? 1 : 0,
    };
  }

  // `group` is the already-resolved link when a caller resolved a whole list;
  // left out, this resolves its own.
  async function getInventorySetById(setId, group) {
    const row = await get(
      `
      SELECT
        inventory_sets.*,
        COALESCE((
          SELECT SUM(quantity)
          FROM inventory_set_lines
          WHERE inventory_set_lines.set_id = inventory_sets.id
        ), 0) AS total_item_count,
        -- A produced set is backed by a materials row, so it has real stock and
        -- a barcode. Both are null for a set someone defined by hand.
        (SELECT m.on_hand_qty FROM materials m
          WHERE m.linked_set_id = inventory_sets.id LIMIT 1) AS on_hand_qty,
        (SELECT m.barcode FROM materials m
          WHERE m.linked_set_id = inventory_sets.id LIMIT 1) AS material_barcode
      FROM inventory_sets
      WHERE inventory_sets.id = ?
      `,
      [setId],
    );
    if (!row) {
      return null;
    }
    const resolvedGroup =
      group === undefined ? (await inventorySetGroups([row.id])).get(String(row.id)) || null : group;
    return rowToInventorySetDto(
      withInventorySetGroup(
        { ...row, asset_photo_url: await inventorySetPhotoUrl(row.id) },
        resolvedGroup,
      ),
      await getInventorySetLineDtos(row.id),
    );
  }

  async function getInventorySets() {
    const rows = await all(
      `
      SELECT
        inventory_sets.*,
        COALESCE((
          SELECT SUM(quantity)
          FROM inventory_set_lines
          WHERE inventory_set_lines.set_id = inventory_sets.id
        ), 0) AS total_item_count
      FROM inventory_sets
      ORDER BY LOWER(inventory_sets.name) ASC, inventory_sets.id ASC
      `,
    );
    const groups = await inventorySetGroups(rows.map((row) => row.id));
    const sets = [];
    for (const row of rows) {
      sets.push(await getInventorySetById(row.id, groups.get(String(row.id)) || null));
    }
    return sets.filter(Boolean);
  }

  async function validateInventorySetLine(line) {
    const itemId = Number(line.itemId || 0);
    const variationLeafNodeId = Number(line.variationLeafNodeId || 0);
    const quantity = Math.trunc(Number(line.quantity || 0));
    if (!Number.isInteger(itemId) || itemId <= 0) {
      const error = new Error('Each set line requires a valid item.');
      error.statusCode = 400;
      throw error;
    }
    if (!Number.isInteger(variationLeafNodeId) || variationLeafNodeId < 0) {
      const error = new Error('Each set line requires a valid variation path.');
      error.statusCode = 400;
      throw error;
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      const error = new Error('Each set line requires quantity greater than 0.');
      error.statusCode = 400;
      throw error;
    }
    const item = await getItemRowById(itemId);
    if (!item || item.is_archived) {
      const error = new Error('Selected item is not available.');
      error.statusCode = 400;
      throw error;
    }
    const itemTree = await getItemVariationTree(itemId);
    const hasOrderableLeaves = activeTopLevelVariationProperties(itemTree).some((propertyNode) =>
      activeChildrenForNode(propertyNode).some((child) => String(child.kind) === 'value'),
    );
    if (variationLeafNodeId === 0) {
      if (hasOrderableLeaves) {
        const error = new Error('Each set line requires a valid variation path.');
        error.statusCode = 400;
        throw error;
      }
      return {
        itemId,
        variationLeafNodeId: 0,
        quantity,
        position: Number(line.position || 0),
      };
    }
    const leafNode = await get(
      `
      SELECT id, item_id, kind, is_archived
      FROM item_variation_nodes
      WHERE id = ?
      `,
      [variationLeafNodeId],
    );
    if (
      !leafNode ||
      Number(leafNode.item_id) !== itemId ||
      String(leafNode.kind || '') !== 'value' ||
      Number(leafNode.is_archived || 0) === 1
    ) {
      const error = new Error('Selected variation path is not valid for this item.');
      error.statusCode = 400;
      throw error;
    }
    const selection = activeValueSelectionForLeaf(
      itemTree,
      variationLeafNodeId,
    );
    if (!selection) {
      const error = new Error('Selected variation path is incomplete for this item.');
      error.statusCode = 400;
      throw error;
    }
    return {
      itemId,
      variationLeafNodeId,
      quantity,
      position: Number(line.position || 0),
    };
  }

  async function saveInventorySet(payload = {}) {
    const id = payload.id == null ? null : Number(payload.id);
    const name = String(payload.name || '').trim();
    if (!name) {
      const error = new Error('Set name is required.');
      error.statusCode = 400;
      throw error;
    }
    const photoUrl = String(payload.photoUrl || '').trim();

    // The version the caller opened this set at, when it knows one. Checked
    // against the stored version below; absent means "do not check", which is
    // what the seeders, the create path and any pre-version client send.
    const expectedVersion =
      payload.expectedVersion === undefined || payload.expectedVersion === null
        ? null
        : Number(payload.expectedVersion);

    // The group is tri-state, and it has to be: this function is a full replace,
    // but the "add spawned items to a set" path sends only id, name and lines.
    // Were an absent key read as "clear", adding items to a set would silently
    // unfile it from its group.
    //   absent            -> leave the link graph alone
    //   present and null  -> clear the group
    //   present with an id -> file it there
    const groupSpecified = Object.prototype.hasOwnProperty.call(payload, 'groupId');
    const groupId =
      !groupSpecified || payload.groupId === null || payload.groupId === ''
        ? null
        : Number(payload.groupId);
    if (groupSpecified && groupId !== null) {
      // Same check, and the same sentence, as saveItem and PATCH /api/items/:id/group.
      const groupRow = await get('SELECT * FROM groups WHERE id = ?', [groupId]);
      if (!groupRow || groupRow.is_archived) {
        const error = new Error('Selected group does not exist or is archived.');
        error.statusCode = 400;
        throw error;
      }
    }

    const mergedLines = mergeInventorySetLines(payload.lines || []);
    if (mergedLines.length === 0) {
      const error = new Error('Add at least one item to the set.');
      error.statusCode = 400;
      throw error;
    }
    const validatedLines = [];
    for (const [index, line] of mergedLines.entries()) {
      validatedLines.push(
        await validateInventorySetLine({
          ...line,
          position: index,
        }),
      );
    }
    const now = new Date().toISOString();
    await run('BEGIN');
    try {
      let setId = id;
      if (setId == null) {
        const result = await run(
          `INSERT INTO inventory_sets (name, photo_url, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          [name, photoUrl, now, now],
        );
        setId = result.lastID;
      } else {
        const existing = await get(
          'SELECT id, name, version FROM inventory_sets WHERE id = ?',
          [setId],
        );
        if (!existing) {
          const error = new Error('Set not found.');
          error.statusCode = 404;
          throw error;
        }
        // This save is a full replace of the line list, so a caller working from
        // a stale copy would erase whatever has happened since. A caller that
        // tells us which version it opened at gets refused instead; one that says
        // nothing keeps the old behaviour, which is what every pre-version client
        // and the seeders rely on.
        if (expectedVersion !== undefined && expectedVersion !== null) {
          if (Number(existing.version || 0) !== Number(expectedVersion)) {
            const error = new Error(
              `"${existing.name}" changed since you opened it. Reload it and make ` +
                'your change again — saving now would replace someone else\'s edit.',
            );
            error.statusCode = 409;
            error.code = 'set_changed';
            throw error;
          }
        }
        await run(
          `UPDATE inventory_sets
              SET name = ?, photo_url = ?, updated_at = ?, version = version + 1
            WHERE id = ?`,
          [name, photoUrl, now, setId],
        );
        await run('DELETE FROM inventory_set_lines WHERE set_id = ?', [setId]);
      }
      for (const line of validatedLines) {
        await run(
          `
          INSERT INTO inventory_set_lines (
            set_id, item_id, variation_leaf_node_id, quantity, position
          ) VALUES (?, ?, ?, ?, ?)
          `,
          [
            setId,
            line.itemId,
            line.variationLeafNodeId === 0 ? null : line.variationLeafNodeId,
            line.quantity,
            line.position,
          ],
        );
      }
      // Filing happens here rather than through POST /api/links so that the
      // editor keeps one save, and so that a user with inventory.update alone can
      // file a set — the links route would also demand items.update, because the
      // catalog maps a group to the items module. The asymmetry that leaves: such
      // a user can re-file from the editor but cannot unlink from the links UI.
      if (groupSpecified) {
        await writeLink('set', setId, 'group', groupId);
      }
      await run('COMMIT');
      return getInventorySetById(setId);
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }

  async function deleteInventorySet(setId) {
    const normalizedSetId = Number(setId);
    if (!Number.isInteger(normalizedSetId) || normalizedSetId <= 0) {
      const error = new Error('Valid set id is required.');
      error.statusCode = 400;
      throw error;
    }
    // Links the set is on either side of, its group among them. No foreign key
    // can cascade a polymorphic pair, so the cascade is asked for by hand.
    const purgeEntityLinks = getPurgeEntityLinks();
    if (purgeEntityLinks) await purgeEntityLinks('set', normalizedSetId);
    await run('DELETE FROM inventory_sets WHERE id = ?', [normalizedSetId]);
  }

  // Which sets hold this part, one row per LINE — a set can hold the same item
  // at two variations, and each of those is its own line with its own quantity.
  //
  // Nothing else answers this question: /usage covers orders, challans, BOM
  // requirements, materials and group links, and inventory_set_lines is in none
  // of them. The item editor needs it to show membership from the part's side.
  //
  // photo_url rides along because a later write to one of these sets has to carry
  // it — saveInventorySet writes the column unconditionally, so a merge that
  // omitted it would clear the set's picture.
  //
  // Temporary sets are left out: their lines are the record of what fed a
  // production run, with a stock ledger behind them, and are not something to
  // hand-edit from a part.
  async function getItemSetMembership(itemId) {
    const normalizedItemId = Number(itemId);
    if (!Number.isInteger(normalizedItemId) || normalizedItemId <= 0) return [];

    const rows = await all(
      `
      SELECT
        lines.id AS line_id,
        lines.quantity,
        lines.variation_leaf_node_id,
        sets.id AS set_id,
        sets.name AS set_name,
        sets.photo_url,
        (SELECT COUNT(*) FROM inventory_set_lines siblings
          WHERE siblings.set_id = sets.id) AS set_line_count
      FROM inventory_set_lines lines
      JOIN inventory_sets sets ON sets.id = lines.set_id
      WHERE lines.item_id = ? AND COALESCE(sets.is_temporary, 0) = 0
      ORDER BY sets.name COLLATE NOCASE ASC, lines.position ASC, lines.id ASC
      `,
      [normalizedItemId],
    );
    if (rows.length === 0) return [];

    // The same label machinery getInventorySetLineDtos uses, so a membership row
    // reads exactly as the line does in the set editor.
    const itemTree = await getItemVariationTree(normalizedItemId);
    const groups = await resolveLinks(
      'set',
      rows.map((row) => row.set_id),
      'group',
    );

    return rows.map((row) => {
      const selection = activeValueSelectionForLeaf(
        itemTree,
        Number(row.variation_leaf_node_id || 0),
      );
      const group = groups.get(String(row.set_id)) || null;
      return {
        lineId: Number(row.line_id),
        setId: Number(row.set_id),
        setName: row.set_name || '',
        photoUrl: row.photo_url || '',
        groupId: group ? Number(group.id) : null,
        groupName: group ? group.label : null,
        quantity: Number(row.quantity || 0),
        variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
        variationPathLabel: selection
          ? buildVariationPathLabel(selection.segments)
          : 'Base item',
        // The SET's line count, not the item's: it is what says whether removing
        // this line would empty the set, which the backend refuses.
        setLineCount: Number(row.set_line_count || 0),
      };
    });
  }

  // --- materials: identity and DTOs --------------------------------------

  function normalizeBarcode(value = '') {
    return String(value)
      .replace(/\s+/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .trim()
      .toUpperCase();
  }

  function generateParentBarcode() {
    const suffix = 1000 + Math.floor(Math.random() * 9000);
    return `PAR-${Date.now()}-${suffix}`;
  }

  function generateChildBarcode(parentBarcode, index) {
    const parts = parentBarcode.split('-');
    const suffix = parts.length > 0 ? parts[parts.length - 1] : parentBarcode;
    return `CHD-${suffix}-${String(index).padStart(2, '0')}`;
  }

  function rowToMaterialDto(row) {
    if (!row) {
      return null;
    }

    const unitLabel = String(row.unit || '').trim();
    const displayStock = String(row.display_stock || '').trim() ||
      (unitLabel
        ? `${Number(row.on_hand_qty || 0)} ${unitLabel}`
        : `${Number(row.on_hand_qty || 0)}`);

    return {
      id: row.id,
      barcode: row.barcode,
      // Exposed because the list endpoint ORDERS BY it — `ORDER BY kind ASC,
      // created_at DESC, barcode ASC` — and without it no client can reproduce
      // the order it was given. A local replica reading these rows back would
      // list them differently from the server for no visible reason.
      kind: row.kind || '',
      name: row.name,
      type: row.type,
      grade: row.grade || '',
      thickness: row.thickness || '',
      supplier: row.supplier || '',
      location: row.location || '',
      unitId: row.unit_id || null,
      unit: row.unit || '',
      notes: row.notes || '',
      groupMode: row.group_mode || null,
      inheritanceEnabled: Number(row.inheritance_enabled || 0) === 1,
      isParent: row.kind === 'parent',
      parentBarcode: row.parent_barcode || null,
      numberOfChildren: row.number_of_children || 0,
      linkedChildBarcodes: parseJson(row.linked_child_barcodes, []),
      scanCount: row.scan_count || 0,
      createdAt: row.created_at,
      linkedGroupId: row.linked_group_id || null,
      linkedItemId: row.linked_item_id || null,
      linkedVariationLeafNodeId: row.linked_variation_leaf_node_id || null,
      displayStock,
      createdBy: row.created_by || 'Demo Admin',
      workflowStatus: row.workflow_status || 'notStarted',
      materialClass: row.material_class || 'raw_material',
      inventoryState: row.inventory_state || 'available',
      procurementState: row.procurement_state || 'not_ordered',
      traceabilityMode: row.traceability_mode || 'bulk',
      onHand: Number(row.on_hand_qty || 0),
      reserved: Number(row.reserved_qty || 0),
      availableToPromise: Number(row.available_to_promise_qty || 0),
      incoming: Number(row.incoming_qty || 0),
      linkedOrderCount: Number(row.linked_order_count || 0),
      linkedPipelineCount: Number(row.linked_pipeline_count || 0),
      pendingAlertCount: Number(row.pending_alert_count || 0),
      updatedAt: row.updated_at || row.created_at,
      lastScannedAt: row.last_scanned_at || null,
    };
  }

  function rowToMaterialActivityDto(row) {
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      barcode: row.barcode || '',
      type: row.event_type || '',
      label: row.event_label || '',
      description: row.event_description || '',
      actor: row.actor || '',
      createdAt: row.created_at,
    };
  }

  // --- materials: creation -----------------------------------------------

  async function createParentWithChildren(payload) {
    const resolvedUnit = await resolveUnitPayload(payload);
    const actor = String(payload?.actor || '').trim() || 'Demo Admin';
    const normalizedGroupMode = String(payload.groupMode || '').trim() || null;
    const shouldCreateMasterGroup = (
      String(payload.type || '').trim() === 'Group' ||
      normalizedGroupMode === 'item_group_authoring' ||
      normalizedGroupMode === 'standalone_group' ||
      normalizedGroupMode === 'nested_group'
    );
    // A child's barcode is CHD-<the parent's last part>-NN, so two parents whose
    // last part matches would give their children the same barcodes. Draw again
    // until neither the parent nor any child of that suffix is taken.
    let parentBarcode = generateParentBarcode();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const suffix = parentBarcode.split('-').pop();
      const taken = await get(
        'SELECT 1 AS taken FROM materials WHERE barcode = ? OR barcode LIKE ? LIMIT 1',
        [parentBarcode, `CHD-${suffix}-%`],
      );
      if (!taken) break;
      parentBarcode = generateParentBarcode();
    }
    const childBarcodes = Array.from(
      { length: Number(payload.numberOfChildren || 0) },
      (_, index) => generateChildBarcode(parentBarcode, index + 1),
    );
    const createdAt = new Date().toISOString();

    await run('BEGIN TRANSACTION');
    try {
      let linkedGroupId = null;
      if (shouldCreateMasterGroup && resolvedUnit.unitId) {
        const group = await saveGroup({
          name: payload.name,
          parentGroupId: payload.parentGroupId ?? null,
          unitId: resolvedUnit.unitId,
        });
        linkedGroupId = group.id;
      }
      const parentResult = await run(
        `
        INSERT INTO materials (
          barcode, name, type, grade, thickness, supplier, location, unit_id, unit, notes, group_mode, inheritance_enabled,
          created_at, kind, parent_barcode, number_of_children,
          linked_child_barcodes, scan_count, linked_group_id, linked_item_id,
          display_stock, created_by, workflow_status, updated_at, last_scanned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parent', NULL, ?, ?, 0, ?, NULL, ?, ?, ?, ?, NULL)
        `,
        [
          parentBarcode,
          payload.name,
          payload.type,
          payload.grade || '',
          payload.thickness || '',
          payload.supplier || '',
          String(payload.location || '').trim(),
          resolvedUnit.unitId,
          resolvedUnit.unit,
          payload.notes || '',
          normalizedGroupMode,
          payload.inheritanceEnabled ? 1 : 0,
          createdAt,
          Number(payload.numberOfChildren || 0),
          JSON.stringify(childBarcodes),
          linkedGroupId,
          resolvedUnit.unit ? `0 ${resolvedUnit.unit}` : '0',
          actor,
          'inProgress',
          createdAt,
        ],
      );

      for (let index = 0; index < childBarcodes.length; index += 1) {
        await run(
          `
          INSERT INTO materials (
            barcode, name, type, grade, thickness, supplier, location, unit_id, unit, notes, group_mode, inheritance_enabled,
            created_at, kind, parent_barcode, number_of_children,
            linked_child_barcodes, scan_count, linked_group_id, linked_item_id,
            display_stock, created_by, workflow_status, updated_at, last_scanned_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'child', ?, 0, ?, 0, NULL, NULL, ?, ?, ?, ?, NULL)
          `,
          [
            childBarcodes[index],
            `${payload.name} - Child ${index + 1}`,
            payload.type,
            payload.grade || '',
            payload.thickness || '',
            payload.supplier || '',
            String(payload.location || '').trim(),
            resolvedUnit.unitId,
            resolvedUnit.unit,
            payload.notes || '',
            normalizedGroupMode,
            payload.inheritanceEnabled ? 1 : 0,
            createdAt,
            parentBarcode,
            JSON.stringify([]),
            resolvedUnit.unit ? `0 ${resolvedUnit.unit}` : '0',
            actor,
            'notStarted',
            createdAt,
          ],
        );
        await logMaterialActivity({
          barcode: childBarcodes[index],
          type: 'created',
          label: 'Item created',
          description: `Inventory item ${payload.name} - Child ${index + 1} was created.`,
          actor,
          createdAt,
        });
      }

      await logMaterialActivity({
        barcode: parentBarcode,
        type: 'created',
        label: 'Group created',
        description: `Inventory group ${payload.name} was created.`,
        actor,
        createdAt,
      });

      await persistMaterialGroupGovernance(parentResult.lastID, payload, createdAt);
      await recomputeMaterialInventorySummary(parentBarcode, createdAt);
      for (const childBarcode of childBarcodes) {
        await recomputeMaterialInventorySummary(childBarcode, createdAt);
      }

      await run('COMMIT');
      const parentRow = await get('SELECT * FROM materials WHERE id = ?', [
        parentResult.lastID,
      ]);
      return rowToMaterialDto(parentRow);
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }

  async function findMaterialByItemSelection(itemId, variationLeafNodeId, customVariationValues = null) {
    let customJson = null;
    if (customVariationValues && Object.keys(customVariationValues).length > 0) {
      const ordered = {};
      Object.keys(customVariationValues).sort().forEach(k => ordered[k] = customVariationValues[k]);
      customJson = JSON.stringify(ordered);
    }

    if (Number(variationLeafNodeId || 0) > 0 || customJson) {
      const exact = await get(
        `
        SELECT *
        FROM materials
        WHERE linked_item_id = ?
          AND COALESCE(linked_variation_leaf_node_id, 0) = ?
          AND COALESCE(custom_variation_values_json, '') = COALESCE(?, '')
        ORDER BY id ASC
        LIMIT 1
        `,
        [itemId, Number(variationLeafNodeId || 0), customJson],
      );
      if (exact) {
        return exact;
      }
    }
    const base = await get(
      `
      SELECT *
      FROM materials
      WHERE linked_item_id = ?
        AND COALESCE(linked_variation_leaf_node_id, 0) = 0
        AND COALESCE(custom_variation_values_json, '') = ''
      ORDER BY id ASC
      LIMIT 1
      `,
      [itemId],
    );
    if (base) {
      return base;
    }
    return get(
      `
      SELECT *
      FROM materials
      WHERE linked_item_id = ?
      ORDER BY id ASC
      LIMIT 1
      `,
      [itemId],
    );
  }

  async function generateBarcodeFromItemSelection(itemId, customVariationValues) {
    if (!customVariationValues || Object.keys(customVariationValues).length === 0) return null;
    const codes = [];
    for (const [propName, valName] of Object.entries(customVariationValues)) {
      const row = await get(`
        SELECT v.code, p.position
        FROM item_variation_nodes v
        JOIN item_variation_nodes p ON v.parent_node_id = p.id
        WHERE v.item_id = ? AND p.name = ? AND (v.name = ? OR v.display_name = ?)
      `, [itemId, propName, valName, valName]);
      if (row && row.code) {
        codes.push({ code: row.code, position: row.position });
      }
    }
    if (codes.length === 0) return null;
    codes.sort((a, b) => a.position - b.position);
    return codes.map(c => c.code).join('-');
  }

  function generateStandaloneMaterialBarcode() {
    return `MAT-${Date.now()}-${Math.floor(Math.random() * 100000)
      .toString()
      .padStart(5, '0')}`;
  }

  async function ensureMaterialForItemSelection({ itemId, variationLeafNodeId = 0, customVariationValues = null, actor = null }) {
    const existing = await findMaterialByItemSelection(itemId, variationLeafNodeId, customVariationValues);
    if (existing) {
      return existing;
    }
    const snapshot = await getItemSelectionSnapshot(itemId, variationLeafNodeId);
    const unit = snapshot.item.unit_id ? await getUnitRowById(snapshot.item.unit_id) : null;
    const now = new Date().toISOString();
  
    // Generate barcode from variation codes if possible
    let barcode = await generateBarcodeFromItemSelection(itemId, customVariationValues);
    if (!barcode) {
      barcode = generateStandaloneMaterialBarcode();
    } else {
      // Ensure uniqueness across the system by checking if it exists
      const existingBarcode = await getMaterialRowByBarcode(barcode);
      if (existingBarcode) {
        // If it exists but wasn't caught by findMaterialByItemSelection, it might be a collision.
        // We'll append a short random string to guarantee uniqueness.
        barcode = `${barcode}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
      }
    }

    // Custom variation values (e.g. {color: "Copper"}) distinguish materials that
    // share an item + leaf node. Persist them (canonical key order, matching
    // findMaterialByItemSelection) and fold the values into the name so each
    // variation gets its own card instead of piling onto the base material.
    let customJson = null;
    let name = snapshot.particulars || snapshot.item.display_name || snapshot.item.name;
    if (customVariationValues && Object.keys(customVariationValues).length > 0) {
      const ordered = {};
      Object.keys(customVariationValues).sort().forEach((k) => { ordered[k] = customVariationValues[k]; });
      customJson = JSON.stringify(ordered);
      const suffix = Object.values(ordered).join(' - ');
      if (suffix && !name.includes(suffix)) {
        name = `${name} - ${suffix}`;
      }
    }

    await run(
      `
      INSERT INTO materials (
        barcode, name, type, grade, thickness, supplier, location, unit_id, unit, notes,
        group_mode, inheritance_enabled, created_at, kind, parent_barcode, number_of_children,
        linked_child_barcodes, scan_count, linked_group_id, linked_item_id, linked_variation_leaf_node_id,
        custom_variation_values_json, display_stock, created_by, workflow_status, material_class, inventory_state, procurement_state,
        traceability_mode, on_hand_qty, reserved_qty, available_to_promise_qty, incoming_qty,
        linked_order_count, linked_pipeline_count, pending_alert_count, updated_at, last_scanned_at
      ) VALUES (?, ?, 'Item', '', '', '', '', ?, ?, '', NULL, 0, ?, 'standalone', NULL, 0, '[]', 0, NULL, ?, ?, ?, ?, ?, 'notStarted', 'finished_good', 'available', 'not_ordered', 'bulk', 0, 0, 0, 0, 0, 0, 0, ?, NULL)
      `,
      [
        barcode,
        name,
        unit?.id || snapshot.item.unit_id || null,
        unit?.symbol || '',
        now,
        snapshot.item.id,
        snapshot.variationLeafNodeId > 0 ? snapshot.variationLeafNodeId : null,
        customJson,
        unit?.symbol ? `0 ${unit.symbol}` : '0',
        actor?.name || actor || 'System',
        now,
      ],
    );
    return getMaterialRowByBarcode(barcode);
  }

  // --- group governance --------------------------------------------------

  function normalizeGroupUnitGovernance(rawUnit) {
    const unitId = Number(rawUnit?.unitId);
    if (!Number.isInteger(unitId) || unitId <= 0) {
      return null;
    }
    const state = String(rawUnit?.state || 'active').trim().toLowerCase() === 'detached'
      ? 'detached'
      : 'active';
    return {
      unitId,
      state,
      isPrimary: Boolean(rawUnit?.isPrimary),
    };
  }

  function normalizeGroupUiPreferences(rawPreferences) {
    return {
      commonOnlyMode: rawPreferences?.commonOnlyMode !== false,
      showPartialMatches: rawPreferences?.showPartialMatches !== false,
    };
  }

  /// Property keys that at least one item under [groupId] actually carries a
  /// value for, taken from the items' own variation trees.
  async function propertyKeysInUseByItems(groupId) {
    const inUse = new Set();
    if (!groupId) {
      return inUse;
    }
    const rows = await all(
      `
      SELECT DISTINCT item_variation_nodes.name AS name
      FROM item_variation_nodes
      INNER JOIN items ON items.id = item_variation_nodes.item_id
      WHERE items.group_id = ?
        AND items.is_archived = 0
        AND item_variation_nodes.kind = 'property'
        AND item_variation_nodes.is_archived = 0
      `,
      [Number(groupId)],
    );
    for (const row of rows) {
      const key = normalizePropertyKey(row.name);
      if (key) {
        inUse.add(key);
      }
    }
    return inUse;
  }

  /// Abundance → scarcity.
  ///
  /// When a group stops asking for a field, the values items already recorded
  /// under it must not evaporate. Any property dropped from [incomingDrafts] that
  /// items still carry is carried forward as `state: 'retired'`: kept in the
  /// schema, hidden from the active field list. A dropped property nothing uses
  /// is simply forgotten.
  async function retireMissingGroupProperties({
    materialId,
    groupId,
    incomingDrafts,
    now,
  }) {
    const existingRows = await all(
      'SELECT * FROM material_group_properties WHERE material_id = ?',
      [materialId],
    );
    if (existingRows.length === 0) {
      return incomingDrafts;
    }

    const incomingKeys = new Set(incomingDrafts.map((draft) => draft.propertyKey));
    const inUseKeys = await propertyKeysInUseByItems(groupId);
    const carriedForward = [];

    for (const row of existingRows) {
      const propertyKey = normalizePropertyKey(row.property_key);
      if (!propertyKey || incomingKeys.has(propertyKey)) {
        continue;
      }
      // Already retired earlier, or still referenced by an item: keep it.
      const wasRetired = String(row.state || '') === 'retired';
      if (!wasRetired && !inUseKeys.has(propertyKey)) {
        continue;
      }
      carriedForward.push(
        normalizeGroupPropertyDraft({
          propertyKey,
          name: row.display_name || propertyKey,
          displayName: row.display_name || propertyKey,
          inputType: row.input_type || 'Text',
          mandatory: false,
          sourceType: row.source_type || 'manual',
          sourceItemIds: parseJson(row.source_item_ids_json, []),
          state: 'retired',
          unitId: row.unit_id ? Number(row.unit_id) : null,
          unitSymbol: row.unit_symbol || null,
          unitLabel: row.unit_label || null,
          sourceGroupId: row.source_group_id ? Number(row.source_group_id) : null,
          sourceGroupName: row.source_group_name || null,
        }),
      );
    }

    return [...incomingDrafts, ...carriedForward.filter(Boolean)];
  }

  async function persistMaterialGroupGovernance(materialId, payload, now = new Date().toISOString()) {
    const selectedItemIds = Array.isArray(payload?.selectedItemIds)
      ? [...new Set(
        payload.selectedItemIds
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0),
      )]
      : [];
    const draftsInput = Array.isArray(payload?.propertyDrafts) ? payload.propertyDrafts : [];
    const unitGovernanceInput = Array.isArray(payload?.unitGovernance)
      ? payload.unitGovernance
      : [];
    const unitGovernance = unitGovernanceInput
      .map(normalizeGroupUnitGovernance)
      .filter(Boolean);
    const preferences = normalizeGroupUiPreferences(payload?.uiPreferences || {});
    const discardedPropertyKeys = normalizeDiscardedPropertyKeys(
      payload?.discardedPropertyKeys,
    );
    const drafts = draftsInput
      .map(normalizeGroupPropertyDraft)
      .filter(Boolean);
    const dedupedDraftsByKey = new Map();
    for (const draft of drafts) {
      if (!dedupedDraftsByKey.has(draft.propertyKey)) {
        dedupedDraftsByKey.set(draft.propertyKey, draft);
      }
    }
    let dedupedDrafts = [...dedupedDraftsByKey.values()];

    // Carry forward anything this save drops that items still rely on, so a
    // group narrowing its fields hides them instead of destroying the values.
    const materialRow = await get('SELECT linked_group_id FROM materials WHERE id = ?', [materialId]);
    dedupedDrafts = await retireMissingGroupProperties({
      materialId,
      groupId: materialRow?.linked_group_id || null,
      incomingDrafts: dedupedDrafts,
      now,
    });

    await run('DELETE FROM material_group_item_links WHERE material_id = ?', [materialId]);
    await run('DELETE FROM material_group_properties WHERE material_id = ?', [materialId]);
    await run('DELETE FROM material_group_units WHERE material_id = ?', [materialId]);
    await run('DELETE FROM material_group_preferences WHERE material_id = ?', [materialId]);

    for (let index = 0; index < selectedItemIds.length; index += 1) {
      await run(
        `
        INSERT INTO material_group_item_links (material_id, item_id, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        `,
        [materialId, selectedItemIds[index], index, now, now],
      );
    }

    for (const draft of dedupedDrafts) {
      await run(
        `
        INSERT INTO material_group_properties (
          material_id, property_key, display_name, input_type, mandatory,
          source_type, source_item_ids_json, state, override_locked, has_type_conflict,
          coverage_count, selected_item_count_at_resolution, resolution_source,
          unit_id, unit_symbol, unit_label, source_group_id, source_group_name,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          materialId,
          draft.propertyKey,
          draft.displayName,
          draft.inputType,
          draft.mandatory ? 1 : 0,
          draft.sourceType,
          JSON.stringify(draft.sourceItemIds),
          draft.state,
          draft.overrideLocked ? 1 : 0,
          draft.hasTypeConflict ? 1 : 0,
          draft.coverageCount,
          draft.selectedItemCountAtResolution,
          draft.resolutionSource,
          draft.unitId,
          draft.unitSymbol,
          draft.unitLabel,
          draft.sourceGroupId,
          draft.sourceGroupName,
          now,
          now,
        ],
      );
    }

    for (const unitRow of unitGovernance) {
      await run(
        `
        INSERT INTO material_group_units (
          material_id, unit_id, state, is_primary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          materialId,
          unitRow.unitId,
          unitRow.state,
          unitRow.isPrimary ? 1 : 0,
          now,
          now,
        ],
      );
    }

    await run(
      `
      INSERT INTO material_group_preferences (
        material_id, common_only_mode, show_partial_matches, discarded_property_keys_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        materialId,
        preferences.commonOnlyMode ? 1 : 0,
        preferences.showPartialMatches ? 1 : 0,
        JSON.stringify(discardedPropertyKeys),
        now,
        now,
      ],
    );
  }

  async function getMaterialGroupGovernance(materialId) {
    const itemLinks = await all(
      `
      SELECT link.item_id, link.sort_order
      FROM material_group_item_links AS link
      WHERE link.material_id = ?
      ORDER BY link.sort_order ASC, link.id ASC
      `,
      [materialId],
    );

    const properties = await all(
      `
      SELECT *
      FROM material_group_properties
      WHERE material_id = ?
      ORDER BY id ASC
      `,
      [materialId],
    );
    const units = await all(
      `
      SELECT *
      FROM material_group_units
      WHERE material_id = ?
      ORDER BY is_primary DESC, id ASC
      `,
      [materialId],
    );
    const preferencesRow = await get(
      `
      SELECT *
      FROM material_group_preferences
      WHERE material_id = ?
      LIMIT 1
      `,
      [materialId],
    );

    const selectedItemIds = itemLinks.map((row) => Number(row.item_id)).filter(Boolean);
    const selectedItems = [];
    for (const row of itemLinks) {
      const itemDesc = await describeItem(row.item_id);
      selectedItems.push({
        itemId: Number(row.item_id),
        itemName: itemDesc?.displayName || itemDesc?.name || `Item #${row.item_id}`,
        sortOrder: Number(row.sort_order || 0),
      });
    }
    const propertyDrafts = properties.map((row) => {
      const sourceItemIds = parseJson(row.source_item_ids_json, [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0);
      const sourceNameById = new Map(selectedItems.map((item) => [item.itemId, item.itemName]));
      const sources = sourceItemIds.map((itemId) => ({
        itemId,
        itemName: sourceNameById.get(itemId) || null,
      }));
      return {
        propertyKey: row.property_key || '',
        name: row.display_name || '',
        inputType: row.input_type || 'Text',
        nameJoin: row.name_join || '',
        mandatory: Number(row.mandatory || 0) === 1,
        sourceType: row.source_type || 'manual',
        state: row.state || 'active',
        unitId: row.unit_id ? Number(row.unit_id) : null,
        unitSymbol: row.unit_symbol || null,
        unitLabel: row.unit_label || null,
        sourceGroupId: row.source_group_id ? Number(row.source_group_id) : null,
        sourceGroupName: row.source_group_name || null,
        overrideLocked: Number(row.override_locked || 0) === 1,
        hasTypeConflict: Number(row.has_type_conflict || 0) === 1,
        coverageCount: Number(row.coverage_count || 0),
        selectedItemCountAtResolution: Number(row.selected_item_count_at_resolution || 0),
        resolutionSource: row.resolution_source || null,
        sources,
      };
    });
    const unitGovernance = units.map((row) => ({
      unitId: Number(row.unit_id),
      state: row.state === 'detached' ? 'detached' : 'active',
      isPrimary: Number(row.is_primary || 0) === 1,
    }));
    const uiPreferences = {
      commonOnlyMode: Number(preferencesRow?.common_only_mode ?? 1) === 1,
      showPartialMatches: Number(preferencesRow?.show_partial_matches ?? 1) === 1,
    };
    const discardedPropertyKeys = normalizeDiscardedPropertyKeys(
      parseJson(preferencesRow?.discarded_property_keys_json, []),
    );

    return {
      selectedItemIds,
      selectedItems,
      propertyDrafts,
      unitGovernance,
      uiPreferences,
      discardedPropertyKeys,
    };
  }

  // --- scans, activity and the stock ledger ------------------------------

  async function incrementMaterialScanCount(barcode) {
    const row = await getMaterialRowByBarcode(barcode);
    if (!row) {
      return null;
    }
    const now = new Date().toISOString();
    await run('INSERT INTO scan_history (barcode, scanned_at) VALUES (?, ?)', [
      row.barcode,
      now,
    ]);
    await run(
      'UPDATE materials SET scan_count = scan_count + 1, updated_at = ?, last_scanned_at = ? WHERE id = ?',
      [now, now, row.id],
    );
    await logMaterialActivity({
      barcode: row.barcode,
      type: 'scan',
      label: 'Material scanned',
      description: `Scan trace updated to ${Number(row.scan_count || 0) + 1} total scans.`,
      actor: 'Scanner',
      createdAt: now,
    });
    return get('SELECT * FROM materials WHERE id = ?', [row.id]);
  }

  async function getMaterialActivity(barcode) {
    const material = await getMaterialRowByBarcode(barcode);
    if (!material) {
      return [];
    }
    return all(
      `
      SELECT *
      FROM material_activity
      WHERE barcode = ?
      ORDER BY datetime(created_at) DESC, id DESC
      `,
      [material.barcode],
    );
  }

  function normalizeMovementType(value = '') {
    const allowed = new Set([
      'receive',
      'issue',
      'transfer',
      'adjust',
      'reserve',
      'release',
      'consume',
      'split',
      'merge',
    ]);
    const normalized = String(value || '').trim().toLowerCase();
    return allowed.has(normalized) ? normalized : 'adjust';
  }

  function normalizeActorLabel(actor, fallback = 'System') {
    if (actor && typeof actor === 'object') {
      const name = String(actor.name || '').trim();
      if (name) {
        return name;
      }
    }
    const text = String(actor || '').trim();
    return text || fallback;
  }

  async function getInventoryStockPosition(materialBarcode, locationId, lotCode) {
    return get(
      `
      SELECT *
      FROM inventory_stock_positions
      WHERE material_barcode = ? AND location_id = ? AND lot_code = ?
      LIMIT 1
      `,
      [materialBarcode, locationId, lotCode],
    );
  }

  async function assertInventoryQuantityAvailable({
    materialBarcode,
    locationId,
    lotCode,
    qty,
    column = 'on_hand_qty',
    label = 'stock',
  }) {
    const position = await getInventoryStockPosition(materialBarcode, locationId, lotCode);
    const available = Number(position?.[column] || 0);
    if (qty > available) {
      const error = new Error(`Insufficient ${label}. Available: ${available}, requested: ${qty}.`);
      error.statusCode = 409;
      throw error;
    }
  }

  function normalizeMaterialClassFromType(type = '') {
    const value = String(type || '').trim().toLowerCase();
    if (value.includes('packaging')) {
      return 'packaging';
    }
    if (value.includes('finished')) {
      return 'finished_good';
    }
    if (value.includes('wip') || value.includes('semi')) {
      return 'wip';
    }
    if (value.includes('chemical') || value.includes('consumable')) {
      return 'consumable';
    }
    return 'raw_material';
  }

  async function upsertInventoryStockPosition({
    materialBarcode,
    locationId = 'MAIN',
    lotCode = '',
    unitId = null,
    onHandDelta = 0,
    reservedDelta = 0,
    damagedDelta = 0,
    now = new Date().toISOString(),
  }) {
    const normalizedLocation = String(locationId || 'MAIN').trim() || 'MAIN';
    const normalizedLot = String(lotCode || '').trim();
    const existing = await get(
      `
      SELECT *
      FROM inventory_stock_positions
      WHERE material_barcode = ? AND location_id = ? AND lot_code = ?
      LIMIT 1
      `,
      [materialBarcode, normalizedLocation, normalizedLot],
    );

    if (!existing) {
      const nextOnHand = Number(onHandDelta || 0);
      const nextReserved = Number(reservedDelta || 0);
      const nextDamaged = Number(damagedDelta || 0);
      if (nextOnHand < 0 || nextReserved < 0 || nextDamaged < 0) {
        const error = new Error('Movement would result in negative stock.');
        error.statusCode = 422;
        throw error;
      }
      await run(
        `
        INSERT INTO inventory_stock_positions (
          material_barcode, location_id, lot_code, unit_id,
          on_hand_qty, reserved_qty, damaged_qty, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          materialBarcode,
          normalizedLocation,
          normalizedLot,
          unitId,
          nextOnHand,
          nextReserved,
          nextDamaged,
          now,
        ],
      );
      return;
    }

    const nextOnHand = Number(existing.on_hand_qty || 0) + Number(onHandDelta || 0);
    const nextReserved = Number(existing.reserved_qty || 0) + Number(reservedDelta || 0);
    const nextDamaged = Number(existing.damaged_qty || 0) + Number(damagedDelta || 0);
    if (nextOnHand < 0 || nextReserved < 0 || nextDamaged < 0) {
      const error = new Error('Movement would result in negative stock.');
      error.statusCode = 422;
      throw error;
    }
    await run(
      `
      UPDATE inventory_stock_positions
      SET unit_id = COALESCE(?, unit_id),
          on_hand_qty = ?,
          reserved_qty = ?,
          damaged_qty = ?,
          updated_at = ?
      WHERE id = ?
      `,
      [unitId, nextOnHand, nextReserved, nextDamaged, now, existing.id],
    );
  }

  /// A material's stock as its positions and reservations hold it: how much is
  /// on hand, and how much of that is promised to something. Reserved is the
  /// larger of the two places a reservation is written, because not every
  /// reservation updates both.
  async function materialStockTotals(barcode) {
    const stockRows = await all(
      'SELECT on_hand_qty, reserved_qty FROM inventory_stock_positions WHERE material_barcode = ?',
      [barcode],
    );
    const reservationRows = await all(
      "SELECT reserved_qty FROM inventory_reservations WHERE material_barcode = ? AND status = 'active'",
      [barcode],
    );
    const onHand = stockRows.reduce((sum, row) => sum + Number(row.on_hand_qty || 0), 0);
    const reservedFromPositions = stockRows.reduce(
      (sum, row) => sum + Number(row.reserved_qty || 0),
      0,
    );
    const reservedFromReservations = reservationRows.reduce(
      (sum, row) => sum + Number(row.reserved_qty || 0),
      0,
    );
    return { onHand, reserved: Math.max(reservedFromPositions, reservedFromReservations) };
  }

  async function recomputeMaterialInventorySummary(materialBarcode, now = new Date().toISOString()) {
    const material = await getMaterialRowByBarcode(materialBarcode);
    if (!material) {
      return null;
    }

    const openAlerts = await all(
      'SELECT * FROM inventory_alerts WHERE material_barcode = ? AND is_open = 1',
      [material.barcode],
    );

    const { onHand, reserved } = await materialStockTotals(material.barcode);
    const availableToPromise = onHand - reserved;
    const linkedOrderCount = material.linked_item_id
      ? Number(
          (
            await get(
              'SELECT COUNT(*) AS count FROM order_items WHERE item_id = ?',
              [material.linked_item_id],
            )
          )?.count || 0,
        )
      : 0;
    const linkedPipelineCount = Number(
      (
        await get(
          'SELECT COUNT(*) AS count FROM run_barcode_inputs WHERE barcode = ?',
          [material.barcode],
        )
      )?.count || 0,
    );
    const pendingAlertCount = openAlerts.length;
    const materialClass = normalizeMaterialClassFromType(material.type);
    // A material whose reception was cancelled stays cancelled: it is kept for
    // the trail, not as stock, and a later recompute must not bring it back.
    const inventoryState = material.inventory_state === 'cancelled'
      ? 'cancelled'
      : (pendingAlertCount > 0 ? 'reserved' : 'available');
    const procurementState = onHand > 0 ? 'received_complete' : 'ordered';
    const traceabilityMode = materialClass === 'raw_material' ? 'lot_tracked' : 'bulk';

    await run(
      `
      UPDATE materials
      SET on_hand_qty = ?,
          reserved_qty = ?,
          available_to_promise_qty = ?,
          display_stock = ?,
          material_class = ?,
          inventory_state = ?,
          procurement_state = ?,
          traceability_mode = ?,
          linked_order_count = ?,
          linked_pipeline_count = ?,
          pending_alert_count = ?,
          updated_at = ?
      WHERE id = ?
      `,
      [
        onHand,
        reserved,
        availableToPromise,
        String(material.unit || '').trim()
          ? `${Number(onHand)} ${String(material.unit || '').trim()}`
          : `${Number(onHand)}`,
        materialClass,
        inventoryState,
        procurementState,
        traceabilityMode,
        linkedOrderCount,
        linkedPipelineCount,
        pendingAlertCount,
        now,
        material.id,
      ],
    );

    const lowStockThreshold = 100;
    const hasLowStock = onHand > 0 && availableToPromise <= lowStockThreshold;
    const existingLowStockAlert = openAlerts.find((alert) => alert.alert_type === 'low_stock');
    if (hasLowStock && !existingLowStockAlert) {
      await run(
        `
        INSERT INTO inventory_alerts (
          material_barcode, alert_type, severity, message, is_open, created_at, updated_at
        ) VALUES (?, 'low_stock', 'warning', ?, 1, ?, ?)
        `,
        [
          material.barcode,
          `Available stock is low (${availableToPromise.toFixed(2)}).`,
          now,
          now,
        ],
      );
    } else if (!hasLowStock && existingLowStockAlert) {
      await run(
        'UPDATE inventory_alerts SET is_open = 0, updated_at = ? WHERE id = ?',
        [now, existingLowStockAlert.id],
      );
    }

    return getMaterialRowByBarcode(material.barcode);
  }

  async function getMaterialControlTowerDetail(barcode) {
    const material = await getMaterialRowByBarcode(barcode);
    if (!material) {
      return null;
    }
    const refreshed = (await recomputeMaterialInventorySummary(material.barcode)) || material;
    const stockRows = await all(
      `
      SELECT *
      FROM inventory_stock_positions
      WHERE material_barcode = ?
      ORDER BY datetime(updated_at) DESC, id DESC
      `,
      [material.barcode],
    );
    const movementRows = await all(
      `
      SELECT *
      FROM inventory_movements
      WHERE material_barcode = ?
      ORDER BY datetime(created_at) DESC
      LIMIT 20
      `,
      [material.barcode],
    );
    const challanIds = [
      ...new Set(
        movementRows
          .map((row) => Number(row.source_challan_id || 0))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    ];
    const challanById = new Map();
    if (challanIds.length > 0) {
      const placeholders = challanIds.map(() => '?').join(', ');
      const challanRows = await all(
        `
        SELECT id, challan_no, type
        FROM delivery_challans
        WHERE id IN (${placeholders})
        `,
        challanIds,
      );
      for (const row of challanRows) {
        challanById.set(Number(row.id), row);
      }
    }
    const reservationRows = await all(
      `
      SELECT *
      FROM inventory_reservations
      WHERE material_barcode = ?
      ORDER BY datetime(updated_at) DESC, id DESC
      `,
      [material.barcode],
    );
    const alertRows = await all(
      `
      SELECT *
      FROM inventory_alerts
      WHERE material_barcode = ?
      ORDER BY is_open DESC, datetime(updated_at) DESC, id DESC
      `,
      [material.barcode],
    );
    const linkedOrderDemand = refreshed.linked_item_id
      ? Number(
          (
            await get('SELECT COALESCE(SUM(quantity), 0) AS qty FROM order_items WHERE item_id = ?', [
              refreshed.linked_item_id,
            ])
          )?.qty || 0,
        )
      : 0;
    const linkedPipelineDemand = Number(
      (
        await get(
          'SELECT COUNT(*) AS count FROM run_barcode_inputs WHERE barcode = ?',
          [material.barcode],
        )
      )?.count || 0,
    );

    const activePipelineInput = await get(
      'SELECT run_id, node_id FROM run_barcode_inputs WHERE barcode = ? ORDER BY scanned_at DESC LIMIT 1',
      [material.barcode]
    );
  
    let activePipelineRun = null;
    if (activePipelineInput) {
      const runId = activePipelineInput.run_id;
      const runRow = await get('SELECT * FROM pipeline_runs WHERE id = ?', [runId]);
      if (runRow) {
         const orderRows = await all('SELECT order_item_id FROM order_pipeline_assignments WHERE pipeline_run_id = ?', [runId]);
         const orderIds = orderRows.map(r => r.order_item_id);
       
         const template = await get('SELECT nodes_json, stage_labels_json FROM pipeline_templates WHERE id = ?', [runRow.template_id]);
         const nodes = template ? parseJson(template.nodes_json, []) : [];
         const stageLabels = template ? parseJson(template.stage_labels_json, []) : [];
         const node = nodes.find(n => n.id === activePipelineInput.node_id);
       
         let machine = null;
         if (node?.machineId) {
            const m = await get('SELECT name, primary_photo_url FROM machines WHERE asset_id = ? OR name = ?', [node.machineId, node.machineId]);
            if (m) machine = { name: m.name, photoUrls: m.primary_photo_url ? [m.primary_photo_url] : [] };
         }
       
         let die = null;
         if (node?.dieId) {
            const d = await get('SELECT tool_code, photo_urls FROM dies WHERE tool_code = ?', [node.dieId]);
            if (d) die = { toolCode: d.tool_code, photoUrls: parseJson(d.photo_urls, []) };
         }
       
         const stages = await all('SELECT * FROM stage_reconciliations WHERE run_id = ?', [runId]);
       
         activePipelineRun = {
           id: runRow.id,
           name: runRow.name || runRow.id,
           status: runRow.status,
           machine,
           die,
           orderIds,
           currentNodeId: activePipelineInput.node_id,
           stages: stages.map(s => ({
              nodeId: s.node_id,
              producedQty: s.produced_qty || 0,
              expectedQty: s.expected_qty || 0,
              rejectedQty: s.rejected_qty || 0
           })),
           nodes,
           stageLabels
         };
      }
    }

    return {
      material: rowToMaterialDto(refreshed),
      activePipelineRun,
      stockPositions: stockRows.map((row) => ({
        locationId: row.location_id || 'MAIN',
        locationName: row.location_id || 'Main Warehouse',
        lotCode: row.lot_code || '',
        unitId: row.unit_id || null,
        onHandQty: Number(row.on_hand_qty || 0),
        reservedQty: Number(row.reserved_qty || 0),
        damagedQty: Number(row.damaged_qty || 0),
        updatedAt: row.updated_at,
      })),
      movements: movementRows.map((row) => ({
        id: String(row.id || ''),
        materialBarcode: row.material_barcode || '',
        movementType: row.movement_type || 'adjust',
        qty: Number(row.qty || 0),
        primaryQty: Number(row.primary_qty || row.qty || 0),
        uom: String(row.uom || '').trim(),
        fromLocationId: row.from_location_id || null,
        toLocationId: row.to_location_id || null,
        reasonCode: row.reason_code || null,
        referenceType: row.reference_type || null,
        referenceId: row.reference_id || null,
        sourceChallanId: row.source_challan_id == null ? null : Number(row.source_challan_id || 0),
        sourceChallanType: row.source_challan_type || null,
        sourceChallanLineId: row.source_challan_line_id == null ? null : Number(row.source_challan_line_id || 0),
        reversesMovementId: row.reverses_movement_id || null,
        sourceLabel: (() => {
          const linkedChallan = challanById.get(Number(row.source_challan_id || 0));
          if (linkedChallan) {
            const typeLabel = normalizeChallanType(linkedChallan.type) === 'reception' ? 'Reception' : 'Delivery';
            if (row.reverses_movement_id || row.reference_type === 'challan-cancellation') {
              return `Cancellation of ${typeLabel} Challan ${linkedChallan.challan_no || `#${linkedChallan.id}`}`;
            }
            return `${typeLabel} Challan ${linkedChallan.challan_no || `#${linkedChallan.id}`}`;
          }
          const referenceType = String(row.reference_type || '').trim();
          const referenceId = String(row.reference_id || '').trim();
          if (referenceType && referenceId) {
            return `${referenceType} ${referenceId}`;
          }
          if (referenceType) {
            return referenceType;
          }
          return null;
        })(),
        actor: row.actor || '',
        createdAt: row.created_at,
      })),
      reservations: reservationRows.map((row) => ({
        referenceType: row.reference_type || '',
        referenceId: row.reference_id || '',
        reservedQty: Number(row.reserved_qty || 0),
        status: row.status || 'active',
      })),
      alerts: alertRows.map((row) => ({
        alertType: row.alert_type || '',
        severity: row.severity || 'warning',
        message: row.message || '',
        isOpen: Number(row.is_open || 0) === 1,
      })),
      linkedOrderDemand,
      linkedPipelineDemand,
      pendingAlertsCount: Number(refreshed.pending_alert_count || 0),
    };
  }

  async function getInventoryHealthSummary() {
    const lowStockCount = Number(
      (
        await get(
          'SELECT COUNT(*) AS count FROM materials WHERE on_hand_qty > 0 AND available_to_promise_qty <= 100',
        )
      )?.count || 0,
    );
    const reservedRiskCount = Number(
      (
        await get(
          'SELECT COUNT(*) AS count FROM materials WHERE reserved_qty > on_hand_qty AND reserved_qty > 0',
        )
      )?.count || 0,
    );
    const incomingTodayCount = Number(
      (
        await get(
          "SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'receive' AND created_at >= ?",
          [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()],
        )
      )?.count || 0,
    );
    const qualityHoldCount = Number(
      (
        await get("SELECT COUNT(*) AS count FROM materials WHERE inventory_state = 'quality_hold'")
      )?.count || 0,
    );
    const pendingReconciliationCount = Number(
      (
        await get('SELECT COUNT(*) AS count FROM inventory_alerts WHERE is_open = 1')
      )?.count || 0,
    );

    return {
      lowStockCount,
      reservedRiskCount,
      incomingTodayCount,
      qualityHoldCount,
      unitMismatchCount: pendingReconciliationCount,
      pendingReconciliationCount,
    };
  }

  async function applyInventoryMovementCore(payload, { useTransaction = true } = {}) {
    const barcode = normalizeBarcode(payload?.barcode || '');
    const movementType = normalizeMovementType(payload?.movementType || 'adjust');
    const qty = Number(payload?.qty || 0);
    if (!barcode || !Number.isFinite(qty) || qty <= 0) {
      const error = new Error('barcode, movementType, and qty (> 0) are required.');
      error.statusCode = 400;
      throw error;
    }

    const material = await getMaterialRowByBarcode(barcode);
    if (!material) {
      const error = new Error('Material not found.');
      error.statusCode = 404;
      throw error;
    }

    const now = new Date().toISOString();
    const movementId = `mov-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const fromLocationId = String(payload?.fromLocationId || '').trim() || null;
    const defaultLocationId = String(material.location || '').trim() || 'MAIN';
    const explicitLot = String(payload?.lotCode || '').trim();
    let toLocationId = String(payload?.toLocationId || '').trim() || defaultLocationId;
    let lotCode = explicitLot || barcode;

    // Issuing/consuming without a caller-specified lot used to target a phantom
    // lot==barcode bucket that's almost always empty — real stock sits under its
    // receiving lot code. Draw from the position that actually holds stock so the
    // assignable quantity matches what inventory shows.
    // ponytail: picks the single fullest lot; add FIFO multi-lot consume only if a
    // single request ever needs to span more than one lot.
    if (!explicitLot && (movementType === 'issue' || movementType === 'consume')) {
      const stockedPosition = await get(
        `
        SELECT location_id, lot_code
        FROM inventory_stock_positions
        WHERE material_barcode = ? AND on_hand_qty > 0
        ORDER BY on_hand_qty DESC
        LIMIT 1
        `,
        [barcode],
      );
      if (stockedPosition) {
        toLocationId = stockedPosition.location_id;
        lotCode = stockedPosition.lot_code;
      }
    }
    const actor = normalizeActorLabel(payload?.actor, 'Demo Admin');
    const sourceChallanId = payload?.sourceChallanId == null
      ? null
      : Number(payload.sourceChallanId || 0) || null;
    const sourceChallanType = payload?.sourceChallanType == null
      ? null
      : normalizeChallanType(payload.sourceChallanType, '');
    const sourceChallanLineId = payload?.sourceChallanLineId == null
      ? null
      : Number(payload.sourceChallanLineId || 0) || null;
    const reversesMovementId = String(payload?.reversesMovementId || '').trim() || null;
    const referenceType = String(payload?.referenceType || '').trim() || null;
    const referenceId = String(payload?.referenceId || '').trim() || null;
    const primaryQty = Number(payload?.primaryQty || qty);
    const uom = String(payload?.uom || '').trim() || String(material.unit || '').trim() || 'units';
    const linkedStockItemId = Number(material.linked_item_id || 0) || null;
    const linkedStockLeafNodeId = Number(material.linked_variation_leaf_node_id || 0) || null;
    const hasChallanProvenance =
      sourceChallanId != null &&
      !!sourceChallanType &&
      sourceChallanLineId != null;
    const hasManualProvenance = !!referenceType && !!referenceId;

    if (movementType === 'transfer' && !fromLocationId) {
      const error = new Error('fromLocationId is required for transfer movements.');
      error.statusCode = 400;
      throw error;
    }
    if (movementType === 'receive' && !hasChallanProvenance && !hasManualProvenance) {
      const error = new Error('Receive movements require challan provenance or a manual reference.');
      error.statusCode = 400;
      throw error;
    }

    if (useTransaction) {
      await run('BEGIN TRANSACTION');
    }
    try {
      if (movementType === 'receive') {
        await upsertInventoryStockPosition({
          materialBarcode: material.barcode,
          locationId: toLocationId,
          lotCode,
          unitId: material.unit_id || null,
          onHandDelta: qty,
          now,
        });
      } else if (movementType === 'transfer') {
        await assertInventoryQuantityAvailable({
          materialBarcode: material.barcode,
          locationId: fromLocationId,
          lotCode,
          qty,
        });
        await upsertInventoryStockPosition({
          materialBarcode: material.barcode,
          locationId: fromLocationId,
          lotCode,
          unitId: material.unit_id || null,
          onHandDelta: -qty,
          now,
        });
        await upsertInventoryStockPosition({
          materialBarcode: material.barcode,
          locationId: toLocationId,
          lotCode,
          unitId: material.unit_id || null,
          onHandDelta: qty,
          now,
        });
      } else if (movementType === 'reserve') {
        await upsertInventoryStockPosition({
          materialBarcode: material.barcode,
          locationId: toLocationId,
          lotCode,
          unitId: material.unit_id || null,
          reservedDelta: qty,
          now,
        });
        await run(
          `
          INSERT INTO inventory_reservations (
            material_barcode, reference_type, reference_id, reserved_qty, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?)
          `,
          [
            material.barcode,
            String(payload?.referenceType || 'manual').trim() || 'manual',
            String(payload?.referenceId || movementId).trim() || movementId,
            qty,
            now,
            now,
          ],
        );
      } else if (movementType === 'release') {
        await assertInventoryQuantityAvailable({
          materialBarcode: material.barcode,
          locationId: toLocationId,
          lotCode,
          qty,
          column: 'reserved_qty',
          label: 'reserved stock',
        });
        await upsertInventoryStockPosition({
          materialBarcode: material.barcode,
          locationId: toLocationId,
          lotCode,
          unitId: material.unit_id || null,
          reservedDelta: -qty,
          now,
        });
        const activeReservation = await get(
          `
          SELECT *
          FROM inventory_reservations
          WHERE material_barcode = ? AND status = 'active'
          ORDER BY datetime(updated_at) DESC, id DESC
          LIMIT 1
          `,
          [material.barcode],
        );
        if (activeReservation) {
          const nextQty = Math.max(0, Number(activeReservation.reserved_qty || 0) - qty);
          await run(
            `
            UPDATE inventory_reservations
            SET reserved_qty = ?, status = ?, updated_at = ?
            WHERE id = ?
            `,
            [nextQty, nextQty <= 0 ? 'released' : 'active', now, activeReservation.id],
          );
        }
      } else {
        if (movementType === 'issue' || movementType === 'consume') {
          await assertInventoryQuantityAvailable({
            materialBarcode: material.barcode,
            locationId: toLocationId,
            lotCode,
            qty,
          });
        }
        const onHandDelta = movementType === 'issue' || movementType === 'consume'
          ? -qty
          : qty;
        await upsertInventoryStockPosition({
          materialBarcode: material.barcode,
          locationId: toLocationId,
          lotCode,
          unitId: material.unit_id || null,
          onHandDelta,
          now,
        });
      }

      await run(
        `
        INSERT INTO inventory_movements (
          id, material_barcode, movement_type, qty, primary_qty, uom, from_location_id, to_location_id,
          reason_code, reference_type, reference_id, source_challan_id, source_challan_type,
          source_challan_line_id, reverses_movement_id, actor, lot_code, created_at,
          item_id, variation_leaf_node_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          movementId,
          material.barcode,
          movementType,
          qty,
          primaryQty,
          uom,
          fromLocationId,
          toLocationId,
          String(payload?.reasonCode || '').trim() || null,
          referenceType,
          referenceId,
          sourceChallanId,
          sourceChallanType || null,
          sourceChallanLineId,
          reversesMovementId,
          actor,
          lotCode,
          now,
          linkedStockItemId,
          linkedStockLeafNodeId,
        ],
      );

      await recomputeMaterialInventorySummary(material.barcode, now);

      if (linkedStockItemId != null && linkedStockLeafNodeId != null) {
        if (movementType === 'receive' || (movementType === 'adjust' && qty > 0)) {
          await applyVariationStockDelta({
            itemId: linkedStockItemId,
            variationLeafNodeId: linkedStockLeafNodeId,
            locationId: toLocationId || 'MAIN',
            delta: qty,
            now,
          });
        } else if (movementType === 'issue' || movementType === 'consume') {
          await applyVariationStockDelta({
            itemId: linkedStockItemId,
            variationLeafNodeId: linkedStockLeafNodeId,
            locationId: toLocationId || 'MAIN',
            delta: -qty,
            now,
          });
        } else if (movementType === 'transfer') {
          await applyVariationStockDelta({
            itemId: linkedStockItemId,
            variationLeafNodeId: linkedStockLeafNodeId,
            locationId: fromLocationId || 'MAIN',
            delta: -qty,
            now,
          });
          await applyVariationStockDelta({
            itemId: linkedStockItemId,
            variationLeafNodeId: linkedStockLeafNodeId,
            locationId: toLocationId || 'MAIN',
            delta: qty,
            now,
          });
        }
      }

      await logMaterialActivity({
        barcode: material.barcode,
        type: movementType,
        label: 'Inventory movement posted',
        description: `${movementType} ${primaryQty.toFixed(2)} ${uom}.`,
        actor,
        createdAt: now,
      });

      // Stock physically changed hands between two places. Only 'transfer' is a
      // move: 'receive', 'consume' and 'issue' are already told by the events
      // that cause them, and re-recording them here would say the same thing
      // twice in a table that cannot be edited afterwards.
      //
      // Locations are strings ('MAIN', a bin id), not records — there is no
      // location entity and so no LOC barcode type to point at. Rather than
      // invent one, the two ends go into metrics as what they actually are. That
      // is an honest amputation: the move is recorded and readable, and it
      // becomes a real link the day locations become records.
      // A transfer whose two ends are the same place moved nothing. The transfer
      // composer only validates "From", so "To" can be left equal to it, and the
      // resulting no-op would otherwise be recorded forever as a move.
      if (movementType === 'transfer' && fromLocationId !== toLocationId) {
        await recordLedgerEvent({
          subjectBarcode: barcodes.encode('MAT', material.barcode),
          eventType: 'LOCATION_MOVED',
          actorName: actor || 'System',
          // Where it now is. One column, two ends — the destination is the one
          // that answers "what is on this rack", which is the question someone
          // scanning a rack is asking. Both ends stay in metrics.
          locationBarcode: toLocationId ? barcodes.encode('LOC', toLocationId) : null,
          metrics: {
            qty: primaryQty,
            unit: uom || '',
            from: fromLocationId || '',
            to: toLocationId || '',
            lotCode: lotCode || '',
          },
          notes: material.name || '',
        });
      }
      if (useTransaction) {
        await run('COMMIT');
      }
    } catch (error) {
      if (useTransaction) {
        await run('ROLLBACK');
      }
      throw error;
    }

    return getMaterialControlTowerDetail(material.barcode);
  }

  async function applyInventoryMovement(payload) {
    return applyInventoryMovementCore(payload, { useTransaction: true });
  }

  // --- editing, linking and deleting a material --------------------------

  async function updateMaterialGroupConfiguration(barcode, payload) {
    const material = await getMaterialRowByBarcode(barcode);
    if (!material) {
      throw new Error('Material not found.');
    }
    const now = new Date().toISOString();
    await run(
      'UPDATE materials SET group_mode = ?, inheritance_enabled = ?, updated_at = ? WHERE id = ?',
      [
        String(payload.groupMode ?? material.group_mode ?? '').trim() || null,
        payload.inheritanceEnabled == null
          ? Number(material.inheritance_enabled || 0)
          : (payload.inheritanceEnabled ? 1 : 0),
        now,
        material.id,
      ],
    );
    await persistMaterialGroupGovernance(material.id, payload, now);
    await logMaterialActivity({
      barcode: material.barcode,
      type: 'governanceUpdated',
      label: 'Inheritance governance updated',
      description: 'Group property inheritance configuration was updated.',
      actor: material.created_by || 'Demo Admin',
      createdAt: now,
    });
    return get('SELECT * FROM materials WHERE id = ?', [material.id]);
  }

  async function logMaterialActivity({
    barcode,
    type,
    label,
    description = '',
    actor = '',
    createdAt = new Date().toISOString(),
  }) {
    await run(
      `
      INSERT INTO material_activity (
        barcode, event_type, event_label, event_description, actor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [barcode, type, label, description, actor, createdAt],
    );
  }

  async function createChildMaterial(parentBarcode, payload) {
    const parent = await getMaterialRowByBarcode(parentBarcode);
    if (!parent || parent.kind !== 'parent') {
      throw new Error('Parent material not found.');
    }
    const actor = String(payload?.actor || '').trim() || parent.created_by || 'Demo Admin';

    const nextIndex = Number(parent.number_of_children || 0) + 1;
    const childBarcode = generateChildBarcode(parent.barcode, nextIndex);
    const createdAt = new Date().toISOString();
    const childDisplayStock = String(parent.unit || '').trim()
      ? `0 ${String(parent.unit || '').trim()}`
      : '0';

    await run(
      `
      INSERT INTO materials (
        barcode, name, type, grade, thickness, supplier, location, unit_id, unit, notes, group_mode, inheritance_enabled,
        created_at, kind, parent_barcode, number_of_children, linked_child_barcodes,
        scan_count, linked_group_id, linked_item_id, display_stock, created_by,
        workflow_status, updated_at, last_scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'child', ?, 0, '[]', 0, NULL, NULL, ?, ?, ?, ?, NULL)
      `,
      [
        childBarcode,
        String(payload.name || '').trim(),
        parent.type || '',
        parent.grade || '',
        parent.thickness || '',
        parent.supplier || '',
        parent.location || '',
        parent.unit_id || null,
        parent.unit || '',
        String(payload.notes || '').trim(),
        parent.group_mode || null,
        Number(parent.inheritance_enabled || 0),
        createdAt,
        parent.barcode,
        childDisplayStock,
        actor,
        'notStarted',
        createdAt,
      ],
    );

    const linkedChildren = parseJson(parent.linked_child_barcodes, []);
    linkedChildren.push(childBarcode);
    await run(
      'UPDATE materials SET number_of_children = ?, linked_child_barcodes = ?, updated_at = ? WHERE id = ?',
      [linkedChildren.length, JSON.stringify(linkedChildren), createdAt, parent.id],
    );

    await logMaterialActivity({
      barcode: childBarcode,
      type: 'created',
      label: 'Sub-group created',
      description: `Created under parent ${parent.name || parent.barcode}.`,
      actor,
      createdAt,
    });
    await recomputeMaterialInventorySummary(childBarcode, createdAt);
    await recomputeMaterialInventorySummary(parent.barcode, createdAt);

    return getMaterialRowByBarcode(childBarcode);
  }

  async function updateMaterialRecord(barcode, payload) {
    const existing = await getMaterialRowByBarcode(barcode);
    if (!existing) {
      throw new Error('Material not found.');
    }

    const resolvedUnit = await resolveUnitPayload(payload);
    const now = new Date().toISOString();
    const actor = String(payload?.actor || '').trim() || existing.created_by || 'Demo Admin';
    const existingDisplayStock = String(existing.display_stock || '').trim();
    const nextDisplayStock = existingDisplayStock || (
      resolvedUnit.unit
        ? `${Number(existing.on_hand_qty || 0)} ${resolvedUnit.unit}`
        : `${Number(existing.on_hand_qty || 0)}`
    );
    await run(
      `
      UPDATE materials
      SET name = ?, type = ?, grade = ?, thickness = ?, supplier = ?, location = ?, unit_id = ?, unit = ?, notes = ?, group_mode = ?, inheritance_enabled = ?, display_stock = ?, updated_at = ?
      WHERE id = ?
      `,
      [
        String(payload.name || '').trim(),
        String(payload.type || '').trim(),
        String(payload.grade || '').trim(),
        String(payload.thickness || '').trim(),
        String(payload.supplier || '').trim(),
        String(payload.location || '').trim(),
        resolvedUnit.unitId,
        resolvedUnit.unit,
        String(payload.notes || '').trim(),
        String(payload.groupMode ?? existing.group_mode ?? '').trim() || null,
        payload.inheritanceEnabled == null
          ? Number(existing.inheritance_enabled || 0)
          : (payload.inheritanceEnabled ? 1 : 0),
        nextDisplayStock,
        now,
        existing.id,
      ],
    );
    await logMaterialActivity({
      barcode: existing.barcode,
      type: 'updated',
      label: 'Record updated',
      description: 'Material details were edited.',
      actor,
      createdAt: now,
    });
    await recomputeMaterialInventorySummary(existing.barcode, now);
    return get('SELECT * FROM materials WHERE id = ?', [existing.id]);
  }

  async function deleteMaterialRecord(barcode) {
    const existing = await getMaterialRowByBarcode(barcode);
    if (!existing) {
      throw new Error('Material not found.');
    }

    if (existing.kind === 'parent') {
      const childRows = await all('SELECT barcode FROM materials WHERE parent_barcode = ?', [
        existing.barcode,
      ]);
      for (const child of childRows) {
        await run('DELETE FROM scan_history WHERE barcode = ?', [child.barcode]);
        await run('DELETE FROM material_activity WHERE barcode = ?', [child.barcode]);
      }
      await run('DELETE FROM materials WHERE parent_barcode = ?', [existing.barcode]);
    } else if (existing.parent_barcode) {
      const parent = await getMaterialRowByBarcode(existing.parent_barcode);
      if (parent) {
        const linkedChildren = parseJson(parent.linked_child_barcodes, []).filter(
          (childBarcode) => childBarcode !== existing.barcode,
        );
        await run(
          'UPDATE materials SET number_of_children = ?, linked_child_barcodes = ? WHERE id = ?',
          [linkedChildren.length, JSON.stringify(linkedChildren), parent.id],
        );
      }
    }

    await run('DELETE FROM scan_history WHERE barcode = ?', [existing.barcode]);
    await run('DELETE FROM material_activity WHERE barcode = ?', [existing.barcode]);
    await run('DELETE FROM material_group_item_links WHERE material_id = ?', [existing.id]);
    await run('DELETE FROM material_group_properties WHERE material_id = ?', [existing.id]);
    await run('DELETE FROM material_group_units WHERE material_id = ?', [existing.id]);
    await run('DELETE FROM material_group_preferences WHERE material_id = ?', [existing.id]);
    await run('DELETE FROM inventory_stock_positions WHERE material_barcode = ?', [existing.barcode]);
    await run('DELETE FROM inventory_movements WHERE material_barcode = ?', [existing.barcode]);
    await run('DELETE FROM inventory_reservations WHERE material_barcode = ?', [existing.barcode]);
    await run('DELETE FROM inventory_alerts WHERE material_barcode = ?', [existing.barcode]);
    await run('DELETE FROM materials WHERE id = ?', [existing.id]);
  }

  async function linkMaterialRecordToGroup(barcode, groupId) {
    const existing = await getMaterialRowByBarcode(barcode);
    if (!existing) {
      throw new Error('Material not found.');
    }
    const group = await getGroupRowById(Number(groupId));
    if (!group || group.is_archived) {
      throw new Error('Selected group is not available.');
    }
    await run(
      'UPDATE materials SET linked_group_id = ?, linked_item_id = NULL, linked_variation_leaf_node_id = NULL, updated_at = ? WHERE id = ?',
      [group.id, new Date().toISOString(), existing.id],
    );
    await logMaterialActivity({
      barcode: existing.barcode,
      type: 'linked',
      label: 'Inheritance linked',
      description: `Linked to group ${group.name || group.id}.`,
      actor: existing.created_by || 'Demo Admin',
    });
    return get('SELECT * FROM materials WHERE id = ?', [existing.id]);
  }

  async function linkMaterialRecordToItem(barcode, itemId, variationLeafNodeId = null) {
    const existing = await getMaterialRowByBarcode(barcode);
    if (!existing) {
      throw new Error('Material not found.');
    }
    const item = await getItemRowById(Number(itemId));
    if (!item || item.is_archived) {
      throw new Error('Selected item is not available.');
    }
    const tree = await getItemVariationTree(item.id);
    const hasActiveVariationProperties = activeTopLevelVariationProperties(tree).length > 0;
    const normalizedLeafId = variationLeafNodeId == null ? null : Number(variationLeafNodeId);
    if (hasActiveVariationProperties) {
      const leafPath = activeValuePathForLeaf(tree, normalizedLeafId);
      const leafNode = findVariationNodeById(tree, normalizedLeafId);
      if (
        !Number.isFinite(normalizedLeafId) ||
        normalizedLeafId <= 0 ||
        !leafNode ||
        leafNode.isArchived ||
        String(leafNode.kind) !== 'value' ||
        !leafPath
      ) {
        const error = new Error('Select an orderable variation leaf before linking this item.');
        error.statusCode = 400;
        throw error;
      }
    } else if (normalizedLeafId != null && normalizedLeafId > 0) {
      const error = new Error('Simple items cannot be linked to a variation leaf.');
      error.statusCode = 400;
      throw error;
    }
    await run(
      'UPDATE materials SET linked_group_id = NULL, linked_item_id = ?, linked_variation_leaf_node_id = ?, updated_at = ? WHERE id = ?',
      [item.id, hasActiveVariationProperties ? normalizedLeafId : null, new Date().toISOString(), existing.id],
    );
    await logMaterialActivity({
      barcode: existing.barcode,
      type: 'linked',
      label: 'Inheritance linked',
      description: `Linked to item ${item.display_name || item.name || item.id}${hasActiveVariationProperties ? ' (Variation ' + normalizedLeafId + ')' : ''}.`,
      actor: existing.created_by || 'Demo Admin',
    });
    return get('SELECT * FROM materials WHERE id = ?', [existing.id]);
  }

  async function unlinkMaterialRecord(barcode) {
    const existing = await getMaterialRowByBarcode(barcode);
    if (!existing) {
      throw new Error('Material not found.');
    }
    await run(
      'UPDATE materials SET linked_group_id = NULL, linked_item_id = NULL, linked_variation_leaf_node_id = NULL, updated_at = ? WHERE id = ?',
      [new Date().toISOString(), existing.id],
    );
    await logMaterialActivity({
      barcode: existing.barcode,
      type: 'unlinked',
      label: 'Inheritance removed',
      description: 'Removed inheritance link.',
      actor: existing.created_by || 'Demo Admin',
    });
    return get('SELECT * FROM materials WHERE id = ?', [existing.id]);
  }

  // --- what a challan asks of the stock tables ------------------------------
  //
  // These were SQL inside the challans module. They are the same statements,
  // moved here so that the tables stay inventory's to write. They deliberately
  // do NOT go through applyInventoryMovementCore: an outgoing challan line names
  // no physical piece (its barcode is '-'), which the engine refuses, and the
  // item's variation stock is adjusted by the challan itself through the items
  // port. Folding the two paths together would change what stock does.

  let movementSequence = Math.floor(Math.random() * 1000);
  /// An id for a movement row. The time, then a counter that never repeats
  /// within this process: two movements written in the same millisecond used to
  /// be told apart by a random number under 1000, which could repeat.
  function nextMovementId() {
    movementSequence = (movementSequence + 1) % 1000000;
    return `mov-${Date.now()}-${movementSequence}`;
  }

  /// Material arriving on a reception challan becomes a barcoded row in
  /// `materials` with a stock position, so the floor can assign it. Returns the
  /// barcode; a line that was already minted returns the one it has.
  async function mintReceivedFromChallanLine({
    challan,
    line,
    itemId,
    leafNodeId,
    quantity,
    uom,
    locationId,
    now,
  }) {
    if (!(itemId > 0) || !(Number(quantity) > 0)) return null;

    // Already minted — issuing is once-only today, but a retry must not create a
    // second pile of stock for the same line.
    const existingRow = await get(
      'SELECT barcode FROM materials WHERE source_challan_item_id = ?',
      [line.id],
    );
    if (existingRow) return existingRow.barcode;

    const itemRow = await get(
      'SELECT id, name, display_name, unit_id FROM items WHERE id = ?',
      [itemId],
    );
    const slug = String(challan.challan_no || challan.id || 'REC')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const base = `${slug}-L${Number(line.line_no || 1)}`;
    let barcode = base;
    for (let suffix = 2; suffix < 50; suffix += 1) {
      const clash = await get('SELECT 1 FROM materials WHERE barcode = ?', [barcode]);
      if (!clash) break;
      barcode = `${base}-${suffix}`;
    }

    const name = String(
      line.particulars || itemRow?.display_name || itemRow?.name || 'Received material',
    ).trim();

    await run(
      `
      INSERT INTO materials (
        barcode, name, type, kind, unit_id, supplier, location,
        on_hand_qty, available_to_promise_qty, material_class, inventory_state,
        linked_item_id, linked_variation_leaf_node_id,
        source_challan_id, source_challan_item_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'parent', ?, ?, ?, ?, ?, 'raw_material', 'available',
                ?, ?, ?, ?, ?, ?)
      `,
      [
        barcode,
        name,
        uom || '',
        itemRow?.unit_id ?? null,
        String(challan.vendor_name || '').trim(),
        locationId,
        quantity,
        quantity,
        itemId,
        leafNodeId || null,
        challan.id,
        line.id,
        now,
        now,
      ],
    );

    // A material row alone is not stock anyone can draw on. Availability is read
    // off `inventory_stock_positions` — barcode, place, lot — and the floor's
    // assign check refuses anything that has no position, so minting without one
    // would leave the received material visible and still unusable.
    await run(
      `
      INSERT INTO inventory_stock_positions (
        material_barcode, location_id, lot_code, unit_id, on_hand_qty,
        reserved_qty, damaged_qty, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, ?)
      `,
      [barcode, locationId, barcode, itemRow?.unit_id ?? null, quantity, now],
    );

    return barcode;
  }

  /// What a reception challan brought in and how much of it the stock tables
  /// still hold. One entry per material the challan minted:
  /// `{ barcode, lineId, itemId, leafNodeId, uom, received, onHand, reserved }`.
  ///
  /// This is only what inventory can see. A vendor sheet scanned onto a run, or
  /// stock issued to a run by quantity, does not lower the position; the caller
  /// asks production for those.
  async function receivedUsageForChallan(challanId) {
    const materials = await all(
      `SELECT barcode, source_challan_item_id, linked_item_id, linked_variation_leaf_node_id
         FROM materials WHERE source_challan_id = ? ORDER BY id ASC`,
      [challanId],
    );
    const entries = [];
    for (const material of materials) {
      const receipt = await get(
        `SELECT COALESCE(SUM(qty), 0) AS qty, MAX(uom) AS uom
           FROM inventory_movements
          WHERE material_barcode = ? AND source_challan_id = ?
            AND movement_type = 'receive' AND reverses_movement_id IS NULL`,
        [material.barcode, challanId],
      );
      const totals = await materialStockTotals(material.barcode);
      entries.push({
        barcode: material.barcode,
        lineId: Number(material.source_challan_item_id || 0) || null,
        itemId: Number(material.linked_item_id || 0) || null,
        leafNodeId: Number(material.linked_variation_leaf_node_id || 0) || 0,
        uom: String(receipt?.uom || '').trim(),
        received: Number(receipt?.qty || 0),
        onHand: totals.onHand,
        reserved: totals.reserved,
      });
    }
    return entries;
  }

  /// The material a reception line became, with the unit it was received in
  /// and what its positions still hold, or null. A cancelled one is not stock.
  async function receivedMaterialForChallanLine(lineId) {
    const material = await get(
      `SELECT barcode, source_challan_id FROM materials
        WHERE source_challan_item_id = ? AND COALESCE(inventory_state, '') != 'cancelled'
        ORDER BY id ASC LIMIT 1`,
      [Number(lineId) || 0],
    );
    if (!material) return null;
    const receipt = await get(
      `SELECT MAX(uom) AS uom FROM inventory_movements
        WHERE material_barcode = ? AND source_challan_id = ? AND movement_type = 'receive'`,
      [material.barcode, material.source_challan_id],
    );
    const totals = await materialStockTotals(material.barcode);
    const uom = String(receipt?.uom || '').trim();
    return {
      barcode: material.barcode,
      uom,
      // Whether the material is kept by weight or counted. The same list the
      // challan issue uses to read a line.
      keptByWeight: ['kg', 'g', 'mg', 'ton', 'tons', 't', 'lbs', 'oz', 'weight'].includes(uom.toLowerCase()),
      onHand: totals.onHand,
    };
  }

  /// Takes a received material out of stock for good once its reception is
  /// cancelled. The row is kept, because the movement ledger and the custody
  /// trail point at its barcode, but it is no longer listed as stock.
  async function retireReceivedMaterial(barcode, now = new Date().toISOString()) {
    await run(
      "UPDATE materials SET inventory_state = 'cancelled', updated_at = ? WHERE barcode = ?",
      [now, barcode],
    );
  }

  /// The stock lot one bucket of an in-use challan settle is received into.
  async function mintReconcileLot({ lotBarcode, name, groupId, itemId, unitSymbol, unitId, createdAt }) {
    await run(
      `INSERT INTO materials (
        barcode, name, type, kind, group_mode,
        linked_group_id, linked_item_id, linked_variation_leaf_node_id,
        unit, unit_id, inventory_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lotBarcode, name, 'Reconciled', 'lot', 'tracked',
        // No variation leaf: the scrap/leftover item is a simple item.
        groupId, itemId, null,
        unitSymbol, unitId, 'available', createdAt,
      ],
    );
  }

  /// The ledger row for one challan line being issued.
  async function recordChallanMovement({
    materialBarcode,
    movementType,
    qty,
    uom,
    locationId,
    reasonCode,
    challanId,
    challanType,
    challanLineId,
    actorName,
    now,
    itemId,
    leafNodeId,
  }) {
    const movementId = nextMovementId();
    await run(
      `
      INSERT INTO inventory_movements (
        id, material_barcode, movement_type, qty, primary_qty, uom,
        to_location_id, reason_code, reference_type, reference_id,
        source_challan_id, source_challan_type, source_challan_line_id,
        actor, lot_code, created_at, item_id, variation_leaf_node_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        movementId,
        materialBarcode,
        movementType,
        qty,
        qty,
        uom,
        locationId,
        reasonCode,
        'challan',
        String(challanId),
        challanId,
        challanType,
        challanLineId,
        actorName,
        '-',
        now,
        itemId,
        leafNodeId
      ]
    );
    return movementId;
  }

  /// Every movement a challan wrote, oldest first: what a cancel or a delete
  /// has to undo.
  function movementsForChallan(challanId, challanType) {
    return all(
      `
      SELECT *
      FROM inventory_movements
      WHERE source_challan_id = ? AND source_challan_type = ?
      ORDER BY created_at ASC, id ASC
      `,
      [challanId, challanType],
    );
  }

  /// The ledger row that undoes one of a cancelled challan's movements, linked
  /// to the movement it reverses.
  async function recordChallanReversal({
    movement,
    reasonCode = 'challan_cancel_reversal',
    referenceType = 'challan-cancellation',
    reverseType,
    stockLocation,
    challanId,
    challanType,
    actorName,
    now,
  }) {
    const movementId = nextMovementId();
    await run(
      `
      INSERT INTO inventory_movements (
        id, material_barcode, movement_type, qty, primary_qty, uom,
        to_location_id, reason_code, reference_type, reference_id,
        source_challan_id, source_challan_type, source_challan_line_id,
        reverses_movement_id, actor, lot_code, created_at, item_id, variation_leaf_node_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        movementId,
        movement.material_barcode || '-',
        reverseType,
        Number(movement.qty || 0),
        Number(movement.primary_qty || movement.qty || 0),
        String(movement.uom || '').trim() || 'units',
        stockLocation,
        reasonCode,
        referenceType,
        String(challanId),
        challanId,
        challanType,
        movement.source_challan_line_id || null,
        movement.id,
        actorName,
        movement.lot_code || movement.material_barcode || '-',
        now,
        movement.item_id,
        movement.variation_leaf_node_id
      ]
    );
    return movementId;
  }

  /// The lot a pipeline run last produced, or ''. A dispatched line that names
  /// the run it came from gets its lot from here.
  async function producedLotCodeForRun(pipelineRunId) {
    const producedLot = await get(
      `SELECT lot_code FROM inventory_movements
       WHERE reference_type = 'pipeline_run' AND reference_id = ?
         AND reason_code = 'production_output'
         AND TRIM(COALESCE(lot_code, '')) != ''
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [String(pipelineRunId)],
    );
    return String(producedLot?.lot_code || '').trim();
  }

  // --- stock overview -------------------------------------------------------

  function mergeCustomVariationValueJsonRows(rows) {
    const valuesByKey = new Map();
    for (const row of rows || []) {
      const parsed = parseJson(row.custom_variation_values_json, {});
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }
      for (const [key, rawValue] of Object.entries(parsed)) {
        const value = String(rawValue || '').trim();
        if (!key || !value) {
          continue;
        }
        if (!valuesByKey.has(key)) {
          valuesByKey.set(key, []);
        }
        const values = valuesByKey.get(key);
        if (!values.includes(value)) {
          values.push(value);
        }
      }
    }
    const merged = {};
    for (const [key, values] of valuesByKey.entries()) {
      if (values.length > 0) {
        merged[key] = values.join(' / ');
      }
    }
    return merged;
  }

  /// One row per item and variation that holds stock, with the item's identity,
  /// the variation path, and every custom variation value anyone has typed for
  /// it (on the stock row, a material, an order line or a challan line), merged
  /// into one.
  async function getStockOverview() {
    const rows = await variationStockRows();
    const stock = [];
    for (const row of rows) {
      const itemDesc = await describeItem(row.item_id);
      row.item_name = itemDesc?.name || 'Unknown Item';
      row.unit_id = itemDesc?.unitId || null;
      row.naming_format = itemDesc?.namingFormat || '[]';
      const selection = await resolveLeafSelectionFromDb(row.variation_leaf_node_id);
      const storedPathNodeIds = parseJson(row.variation_path_node_ids_json, []);
      const effectivePathNodeIds = storedPathNodeIds.length > 0
        ? storedPathNodeIds
        : (selection?.nodeIds || []);
      // In the order the one query used to produce them: the stock row's own,
      // then materials, then order lines, then challan lines. The merge keeps
      // the first spelling of a value it meets.
      const customVariationRows = [
        { custom_variation_values_json: row.stock_custom_variation_values_json || '{}' },
        ...(await all(
          `
          SELECT custom_variation_values_json
          FROM materials
          WHERE linked_item_id = ?
            AND COALESCE(linked_variation_leaf_node_id, 0) = ?
            AND TRIM(COALESCE(custom_variation_values_json, '')) NOT IN ('', '{}')
          `,
          [row.item_id, row.variation_leaf_node_id],
        )),
        ...(await orders.customVariationValueRows(row.item_id, row.variation_leaf_node_id)),
        ...(await challans.customVariationValueRows(row.item_id, row.variation_leaf_node_id)),
      ];
      stock.push({
        ...row,
        custom_variation_values: mergeCustomVariationValueJsonRows(customVariationRows),
        variation_path_label: row.variation_path_label || '',
        variation_path_node_ids: effectivePathNodeIds,
        variation_path: effectivePathNodeIds.map((nodeId, index) => ({
          node_id: nodeId,
          value: selection?.nodeIds?.includes(nodeId)
            ? (selection?.segments?.[selection.nodeIds.indexOf(nodeId)] || '')
            : '',
        })),
      });
    }
    return stock;
  }

  return {
    rowToInventorySetDto,
    mergeInventorySetLines,
    getInventorySetLineDtos,
    getInventorySetById,
    getInventorySets,
    validateInventorySetLine,
    saveInventorySet,
    deleteInventorySet,
    getItemSetMembership,
    normalizeBarcode,
    generateParentBarcode,
    generateChildBarcode,
    rowToMaterialDto,
    rowToMaterialActivityDto,
    createParentWithChildren,
    findMaterialByItemSelection,
    generateBarcodeFromItemSelection,
    generateStandaloneMaterialBarcode,
    ensureMaterialForItemSelection,
    normalizeGroupUnitGovernance,
    normalizeGroupUiPreferences,
    propertyKeysInUseByItems,
    retireMissingGroupProperties,
    persistMaterialGroupGovernance,
    getMaterialGroupGovernance,
    incrementMaterialScanCount,
    getMaterialActivity,
    normalizeMovementType,
    normalizeActorLabel,
    getInventoryStockPosition,
    assertInventoryQuantityAvailable,
    normalizeMaterialClassFromType,
    upsertInventoryStockPosition,
    recomputeMaterialInventorySummary,
    getMaterialControlTowerDetail,
    getInventoryHealthSummary,
    applyInventoryMovementCore,
    applyInventoryMovement,
    updateMaterialGroupConfiguration,
    logMaterialActivity,
    createChildMaterial,
    updateMaterialRecord,
    deleteMaterialRecord,
    linkMaterialRecordToGroup,
    linkMaterialRecordToItem,
    unlinkMaterialRecord,
    getStockOverview,
    mintReceivedFromChallanLine,
    mintReconcileLot,
    recordChallanMovement,
    movementsForChallan,
    recordChallanReversal,
    receivedUsageForChallan,
    receivedMaterialForChallanLine,
    retireReceivedMaterial,
    producedLotCodeForRun,
    /// An item is going away: its lines in every set go with it. trashAndDelete
    /// removes the item with foreign keys off, so the declared cascade never
    /// fires and a set would keep a nameless ghost line.
    removeSetLinesForItem(itemId) {
      return run('DELETE FROM inventory_set_lines WHERE item_id = ?', [itemId]);
    },
  };
}

module.exports = { createInventoryService };
