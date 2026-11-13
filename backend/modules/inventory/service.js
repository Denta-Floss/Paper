'use strict';

// ---------------------------------------------------------------------------
// The inventory module's service.
//
// Grows commit by commit as inventory leaves server.js. Today it holds the SETS:
// definitions of what a set is made of (a bill of material with quantities), how
// a set is filed under a group, and its photo. Materials, governance and the
// stock ledger follow.
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
}) {
  const {
    getItemVariationTree,
    activeValueSelectionForLeaf,
    buildVariationPathLabel,
    getItemRowById,
    activeTopLevelVariationProperties,
    activeChildrenForNode,
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
    /// An item is going away: its lines in every set go with it. trashAndDelete
    /// removes the item with foreign keys off, so the declared cascade never
    /// fires and a set would keep a nameless ghost line.
    removeSetLinesForItem(itemId) {
      return run('DELETE FROM inventory_set_lines WHERE item_id = ?', [itemId]);
    },
  };
}

module.exports = { createInventoryService };
