'use strict';

// An item's variation tree as stored, and the stock questions asked of it:
// which leaf a line means, whether an item has variations at all, and the
// one write path into variation_stock.
//
// A factory: `deps` is what server.js still owns (the database helpers and
// a few shared helpers), `api` is the items service being assembled, through
// which these reach the sibling files; both are read at call time.

const { activeTopLevelVariationProperties, activeValueSelectionForLeaf, buildVariationPathLabel, findVariationNodeById, variationPathLabelForNodeIds } = require('./variation-tree');

function createVariations(deps, api) {
  const { all, get, normalizeCustomVariationValues, run } = deps;
  const getItemRowById = (...args) => api.getItemRowById(...args);

  async function getItemVariationNodeRows(itemId) {
    return all(
      `
      SELECT *
      FROM item_variation_nodes
      WHERE item_id = ? AND is_archived = 0
      ORDER BY parent_node_id ASC, position ASC, LOWER(name) ASC
      `,
      [itemId],
    );
  }

  async function getItemVariationTree(itemId) {
    const rows = await getItemVariationNodeRows(itemId);
    const rowMap = new Map();
    for (const row of rows) {
      rowMap.set(row.id, {
        id: row.id,
        itemId: row.item_id,
        parentNodeId: row.parent_node_id,
        kind: row.kind || 'property',
        name: row.name || '',
        code: row.code || '',
        displayName: row.display_name || '',
        inputType: row.input_type || 'Text',
        nameJoin: row.name_join || '',
        numericMin: row.numeric_min == null ? null : Number(row.numeric_min),
        numericMax: row.numeric_max == null ? null : Number(row.numeric_max),
        // Set on a value node under a Material property: which material type the
        // value stands for, so density travels with the selection.
        materialTypeId:
          row.material_type_id == null ? null : Number(row.material_type_id),
        position: row.position || 0,
        isArchived: Boolean(row.is_archived),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        children: [],
      });
    }

    const roots = [];
    for (const row of rows) {
      const node = rowMap.get(row.id);
      if (row.parent_node_id == null) {
        roots.push(node);
      } else {
        const parent = rowMap.get(row.parent_node_id);
        if (parent) {
          parent.children.push(node);
        }
      }
    }

    const sortNodes = (nodes) => {
      nodes.sort((a, b) => {
        if (a.position !== b.position) {
          return a.position - b.position;
        }
        return String(a.name || '').localeCompare(String(b.name || ''), undefined, {
          sensitivity: 'base',
        });
      });
      for (const node of nodes) {
        sortNodes(node.children);
      }
    };

    sortNodes(roots);
    return roots;
  }

  async function resolveLeafSelectionFromDb(leafNodeId) {
    const nodeIds = [];
    const segments = [];
    let currentId = leafNodeId;
    while (currentId) {
      const node = await get('SELECT id, parent_node_id, name, kind FROM item_variation_nodes WHERE id = ?', [currentId]);
      if (!node) {
        break;
      }
      if (node.kind === 'value') {
        nodeIds.unshift(node.id);
        segments.unshift(node.name);
      }
      currentId = node.parent_node_id;
    }
    if (nodeIds.length === 0 || nodeIds[nodeIds.length - 1] !== leafNodeId) {
      return null;
    }
    return {
      nodeIds,
      segments,
    };
  }

  /// Whether an item's stock is one figure for the whole item: it has no
  /// variations to keep stock under. Such an item's stock row carries leaf 0.
  async function itemHoldsWholeItemStock(itemId) {
    const normalizedItemId = Number(itemId || 0);
    if (!normalizedItemId) return false;
    const item = await getItemRowById(normalizedItemId);
    if (!item) return false;
    const tree = await getItemVariationTree(normalizedItemId);
    return activeTopLevelVariationProperties(tree).length === 0;
  }

  /// The one rule for where an item's stock may be kept. An item with variations
  /// keeps it under a variation leaf, and must name one. An item with none keeps
  /// one figure for the whole item, under leaf 0.
  async function assertValidStockVariationLeaf(itemId, variationLeafNodeId) {
    const normalizedItemId = Number(itemId || 0);
    const normalizedLeafNodeId = Number(variationLeafNodeId || 0);
    if (!normalizedItemId) {
      const error = new Error('Stock-managed inventory lines must reference an item.');
      error.statusCode = 400;
      throw error;
    }
    if (!normalizedLeafNodeId) {
      if (await itemHoldsWholeItemStock(normalizedItemId)) return;
      const error = new Error('Stock-managed inventory lines must reference an item variation leaf.');
      error.statusCode = 400;
      throw error;
    }

    const row = await get(
      `
      SELECT leaf.id
      FROM item_variation_nodes leaf
      LEFT JOIN item_variation_nodes child
        ON child.parent_node_id = leaf.id
        AND child.is_archived = 0
      WHERE leaf.id = ?
        AND leaf.item_id = ?
        AND leaf.kind = 'value'
        AND leaf.is_archived = 0
      GROUP BY leaf.id
      HAVING COUNT(child.id) = 0
      `,
      [normalizedLeafNodeId, normalizedItemId],
    );
    if (!row) {
      const error = new Error('Stock-managed inventory lines must reference a valid item variation leaf.');
      error.statusCode = 400;
      throw error;
    }
  }

  async function applyVariationStockDelta({
    itemId,
    variationLeafNodeId,
    locationId = 'MAIN',
    variationPathLabel = '',
    variationPathNodeIds = [],
    customVariationValues = {},
    delta,
    now = new Date().toISOString(),
  }) {
    const normalizedItemId = Number(itemId || 0);
    const normalizedLeafNodeId = Number(variationLeafNodeId || 0);
    const normalizedLocationId = String(locationId || '').trim() || 'MAIN';
    const normalizedDelta = Number(delta || 0);
    const normalizedVariationPathLabel = String(variationPathLabel || '').trim();
    const normalizedVariationPathNodeIds = Array.isArray(variationPathNodeIds)
      ? variationPathNodeIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id !== 0)
      : [];
    const normalizedCustomVariationValues = normalizeCustomVariationValues(customVariationValues || {});
    if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0) {
      return;
    }

    await assertValidStockVariationLeaf(normalizedItemId, normalizedLeafNodeId);

    if (normalizedDelta < 0) {
      const currentStock = await get(
        `
        SELECT quantity
        FROM variation_stock
        WHERE item_id = ? AND variation_leaf_node_id = ? AND location_id = ?
        `,
        [normalizedItemId, normalizedLeafNodeId, normalizedLocationId],
      );
      const onHand = Number(currentStock?.quantity || 0);
      const nextQuantity = onHand + normalizedDelta;
      if (nextQuantity < -0.000001) {
        const error = new Error(
          `Insufficient stock for item id ${normalizedItemId}. On hand: ${onHand}, Required: ${Math.abs(normalizedDelta)}. Stock cannot go negative.`,
        );
        error.statusCode = 400;
        throw error;
      }
    }

    const insertedQuantity = normalizedDelta > 0 ? normalizedDelta : 0;
    await run(
      `
      INSERT INTO variation_stock (
        item_id, variation_leaf_node_id, quantity, location_id,
        variation_path_label, variation_path_node_ids_json, custom_variation_values_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id, variation_leaf_node_id, location_id)
      DO UPDATE SET
        quantity = variation_stock.quantity + ?,
        variation_path_label = CASE
          WHEN TRIM(excluded.variation_path_label) <> '' THEN excluded.variation_path_label
          ELSE variation_stock.variation_path_label
        END,
        variation_path_node_ids_json = CASE
          WHEN excluded.variation_path_node_ids_json <> '[]' THEN excluded.variation_path_node_ids_json
          ELSE variation_stock.variation_path_node_ids_json
        END,
        custom_variation_values_json = CASE
          WHEN excluded.custom_variation_values_json <> '{}' THEN excluded.custom_variation_values_json
          ELSE variation_stock.custom_variation_values_json
        END,
        updated_at = excluded.updated_at
      `,
      [
        normalizedItemId,
        normalizedLeafNodeId,
        insertedQuantity,
        normalizedLocationId,
        normalizedVariationPathLabel,
        JSON.stringify(normalizedVariationPathNodeIds),
        JSON.stringify(normalizedCustomVariationValues),
        now,
        normalizedDelta,
      ],
    );
  }

  async function resolveOrderVariationSelection({
    itemId,
    variationLeafNodeId = 0,
    variationPathNodeIds = [],
    variationPathLabel = '',
    status = 'notStarted',
  }) {
    const item = await getItemRowById(itemId);
    if (!item || item.is_archived) {
      const error = new Error('Selected item is not available.');
      error.statusCode = 400;
      throw error;
    }

    const tree = await getItemVariationTree(item.id);
    const hasActiveVariationProperties = activeTopLevelVariationProperties(tree).length > 0;
    const pathNodeIdsWithCustom = Array.isArray(variationPathNodeIds)
      ? variationPathNodeIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id !== 0)
      : [];
    const normalizedPathNodeIds = pathNodeIdsWithCustom.filter(id => id > 0);
    let normalizedLeafId = Number(variationLeafNodeId || 0);

    if (!hasActiveVariationProperties) {
      return {
        item,
        variationLeafNodeId: 0,
        variationPathNodeIds: [],
        variationPathNodeIdsJson: '[]',
        variationPathLabel: '',
      };
    }

    if ((!Number.isFinite(normalizedLeafId) || normalizedLeafId <= 0) && normalizedPathNodeIds.length > 0) {
      normalizedLeafId = normalizedPathNodeIds[normalizedPathNodeIds.length - 1];
    }
    const isDraft = status === 'draft';
    if (!Number.isFinite(normalizedLeafId) || normalizedLeafId <= 0) {
      if (isDraft) {
        const draftPath = [...normalizedPathNodeIds];
        return {
          item,
          variationLeafNodeId: 0,
          variationPathNodeIds: draftPath,
          variationPathNodeIdsJson: JSON.stringify(draftPath),
          variationPathLabel: variationPathLabelForNodeIds(tree, draftPath),
        };
      }
      const error = new Error('Client, item, and variation values are required.');
      error.statusCode = 400;
      throw error;
    }

    let leafNode = findVariationNodeById(tree, normalizedLeafId);
    let leafSelection = activeValueSelectionForLeaf(tree, normalizedLeafId);

    if (!leafNode || leafNode.isArchived || !leafSelection) {
      const dbNode = await get('SELECT * FROM item_variation_nodes WHERE id = ? AND item_id = ?', [normalizedLeafId, item.id]);
      if (dbNode && dbNode.kind === 'value') {
        const selectionFromDb = await resolveLeafSelectionFromDb(normalizedLeafId);
        if (selectionFromDb) {
          leafNode = {
            id: dbNode.id,
            itemId: dbNode.item_id,
            parentNodeId: dbNode.parent_node_id,
            kind: dbNode.kind,
            name: dbNode.name,
            code: dbNode.code,
            displayName: dbNode.display_name,
            position: dbNode.position,
            isArchived: Boolean(dbNode.is_archived),
          };
          leafSelection = selectionFromDb;
        }
      }
    }

    if (
      !leafNode ||
      String(leafNode.kind) !== 'value' ||
      !leafSelection
    ) {
      const error = new Error('Selected variation leaf is not available for this item.');
      error.statusCode = 400;
      throw error;
    }
    return {
      item,
      variationLeafNodeId: normalizedLeafId,
      variationPathNodeIds: pathNodeIdsWithCustom.length > 0 ? pathNodeIdsWithCustom : leafSelection.nodeIds,
      variationPathNodeIdsJson: JSON.stringify(pathNodeIdsWithCustom.length > 0 ? pathNodeIdsWithCustom : leafSelection.nodeIds),
      variationPathLabel: variationPathLabel ? String(variationPathLabel).trim() : buildVariationPathLabel(leafSelection.segments),
    };
  }

  return { getItemVariationNodeRows, getItemVariationTree, resolveLeafSelectionFromDb, itemHoldsWholeItemStock, assertValidStockVariationLeaf, applyVariationStockDelta, resolveOrderVariationSelection };
}

module.exports = { createVariations };
