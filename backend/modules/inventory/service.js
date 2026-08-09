'use strict';

// ---------------------------------------------------------------------------
// Inventory module — domain service (kernel rule K5).
//
// The inventory domain logic, moved VERBATIM out of server.js.
// Dependencies are injected rather than imported, with zero reach into the monolith:
// db primitives (get/all/run), normalizers, itemsPorts, and injected seam thunks
// for queries against foreign-module territory.
// ---------------------------------------------------------------------------

module.exports = function createInventoryService(ctx) {
  const {
    all,
    get,
    run,
    itemsPorts,
    logChange,
    parseJson,
    normalizeBarcode,
    normalizeChallanType,
    saveGroup,
    getItemRowById,
    getGroupRowById,
    getItemVariationTree,
    activeValueSelectionForLeaf,
    activeValuePathForLeaf,
    findVariationNodeById,
    activeTopLevelVariationProperties,
    activeChildrenForNode,
    buildVariationPathLabel,
    // Foreign territory seams (K5)
    resolveUnitPayload,
    propertyKeysInUseByItems,
    getChallansByIds,
    getActivePipelineRunForMaterial,
    getLinkedOrderItemDemand,
    getLinkedOrderCount,
    getLinkedPipelineCount,
    getVariationStockRows,
    resolveLeafSelectionFromDb,
    queryForeignCustomVariationRows,
    getVariationLeafNodeById,
  } = ctx;

  let _parentBarcodeSeq = 1000 + Math.floor(Math.random() * 1000);
  function generateParentBarcode() {
    _parentBarcodeSeq = ((_parentBarcodeSeq + 1) % 9000) + 1000;
    return `PAR-${Date.now()}-${_parentBarcodeSeq}`;
  }

  function generateChildBarcode(parentBarcode, index) {
    const parts = parentBarcode.split('-');
    const suffix = parts.length > 0 ? parts[parts.length - 1] : parentBarcode;
    return `CHD-${suffix}-${String(index).padStart(2, '0')}`;
  }

  function normalizePropertyKey(value = '') {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
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

  function normalizeDiscardedPropertyKeys(rawKeys) {
    if (!Array.isArray(rawKeys)) {
      return [];
    }
    const keys = [];
    const seen = new Set();
    for (const rawKey of rawKeys) {
      const propertyKey = normalizePropertyKey(rawKey);
      if (!propertyKey || seen.has(propertyKey)) {
        continue;
      }
      seen.add(propertyKey);
      keys.push(propertyKey);
    }
    return keys;
  }

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

  function normalizeGroupPropertyDraft(rawDraft) {
    const name = String(rawDraft?.name || '').trim();
    if (!name) {
      return null;
    }
    const propertyKey =
      String(rawDraft?.propertyKey || '').trim() || normalizePropertyKey(name);
    const inputType = String(rawDraft?.inputType || 'Text').trim() || 'Text';
    const sourceType = ['inherited_item', 'inherited_group', 'manual'].includes(rawDraft?.sourceType)
      ? rawDraft.sourceType
      : 'manual';
    const state = ['active', 'unlinked', 'overridden', 'retired'].includes(rawDraft?.state)
      ? rawDraft.state
      : 'active';
    const overrideLocked = Boolean(rawDraft?.overrideLocked);
    const hasTypeConflict = Boolean(rawDraft?.hasTypeConflict);
    const mandatory = Boolean(rawDraft?.mandatory);
    const unitId = Number(rawDraft?.unitId);
    const unitSymbol = String(rawDraft?.unitSymbol || '').trim() || null;
    const unitLabel = String(rawDraft?.unitLabel || '').trim() || null;
    const sourceGroupId = Number(rawDraft?.sourceGroupId);
    const sourceGroupName = String(rawDraft?.sourceGroupName || '').trim() || null;
    const coverageCount = Number(rawDraft?.coverageCount || 0);
    const selectedItemCountAtResolution = Number(
      rawDraft?.selectedItemCountAtResolution || 0,
    );
    const resolutionSource = String(rawDraft?.resolutionSource || '').trim() || null;
    const sources = Array.isArray(rawDraft?.sources) ? rawDraft.sources : [];
    const sourceItemIds = sources
      .map((source) => Number(source?.itemId))
      .filter((id) => Number.isInteger(id) && id > 0);

    return {
      propertyKey,
      displayName: name,
      inputType,
      sourceType,
      state,
      mandatory,
      unitId: Number.isInteger(unitId) && unitId > 0 ? unitId : null,
      unitSymbol,
      unitLabel,
      sourceGroupId: Number.isInteger(sourceGroupId) && sourceGroupId > 0 ? sourceGroupId : null,
      sourceGroupName,
      overrideLocked,
      hasTypeConflict,
      coverageCount: Number.isFinite(coverageCount) ? Math.max(0, Math.trunc(coverageCount)) : 0,
      selectedItemCountAtResolution: Number.isFinite(selectedItemCountAtResolution)
        ? Math.max(0, Math.trunc(selectedItemCountAtResolution))
        : 0,
      resolutionSource,
      sourceItemIds: [...new Set(sourceItemIds)],
    };
  }

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
      lines,
    };
  }

  async function getMaterialRowByBarcode(barcode) {
    const normalized = normalizeBarcode(barcode);
    const rows = await all('SELECT * FROM materials');
    return rows.find((item) => normalizeBarcode(item.barcode) === normalized) || null;
  }

  async function getGroupMaterialRowByGroupId(groupId) {
    const normalizedGroupId = Number(groupId);
    if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) {
      return null;
    }
    return get(
      `
      SELECT *
      FROM materials
      WHERE linked_group_id = ?
      ORDER BY id ASC
      LIMIT 1
      `,
      [normalizedGroupId],
    );
  }

  async function getInventoryStockList() {
    const rows = getVariationStockRows
      ? await getVariationStockRows()
      : [];
    const stock = [];
    for (const row of rows) {
      const itemDesc = itemsPorts ? await itemsPorts.describe(row.item_id) : null;
      row.item_name = itemDesc?.name || 'Unknown Item';
      row.unit_id = itemDesc?.unitId || null;
      row.naming_format = itemDesc?.namingFormat || '[]';
      const selection = resolveLeafSelectionFromDb
        ? await resolveLeafSelectionFromDb(row.variation_leaf_node_id)
        : null;
      const storedPathNodeIds = parseJson(row.variation_path_node_ids_json, []);
      const effectivePathNodeIds = storedPathNodeIds.length > 0
        ? storedPathNodeIds
        : (selection?.nodeIds || []);
      
      const ownMaterialCustomRows = await all(
        `
        SELECT ? AS custom_variation_values_json
        UNION ALL
        SELECT custom_variation_values_json
        FROM materials
        WHERE linked_item_id = ?
          AND COALESCE(linked_variation_leaf_node_id, 0) = ?
          AND TRIM(COALESCE(custom_variation_values_json, '')) NOT IN ('', '{}')
        `,
        [
          row.stock_custom_variation_values_json || '{}',
          row.item_id,
          row.variation_leaf_node_id,
        ],
      );
      const foreignCustomRows = queryForeignCustomVariationRows
        ? await queryForeignCustomVariationRows(row.item_id, row.variation_leaf_node_id)
        : [];
      const customVariationRows = [...ownMaterialCustomRows, ...foreignCustomRows];

      stock.push({
        ...row,
        custom_variation_values: mergeCustomVariationValueJsonRows(customVariationRows),
        variation_path_label: row.variation_path_label || '',
        variation_path_node_ids: effectivePathNodeIds,
        variation_path: effectivePathNodeIds.map((nodeId) => ({
          node_id: nodeId,
          value: selection?.nodeIds?.includes(nodeId)
            ? (selection?.segments?.[selection.nodeIds.indexOf(nodeId)] || '')
            : '',
        })),
      });
    }
    return stock;
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

  async function recomputeMaterialInventorySummary(materialBarcode, now = new Date().toISOString()) {
    const material = await getMaterialRowByBarcode(materialBarcode);
    if (!material) {
      return null;
    }

    const stockRows = await all(
      'SELECT * FROM inventory_stock_positions WHERE material_barcode = ?',
      [material.barcode],
    );
    const reservationRows = await all(
      "SELECT * FROM inventory_reservations WHERE material_barcode = ? AND status = 'active'",
      [material.barcode],
    );
    const openAlerts = await all(
      'SELECT * FROM inventory_alerts WHERE material_barcode = ? AND is_open = 1',
      [material.barcode],
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
    const reserved = Math.max(reservedFromPositions, reservedFromReservations);
    const availableToPromise = onHand - reserved;
    const linkedOrderCount = material.linked_item_id && getLinkedOrderCount
      ? await getLinkedOrderCount(material.linked_item_id)
      : 0;
    const linkedPipelineCount = getLinkedPipelineCount
      ? await getLinkedPipelineCount(material.barcode)
      : 0;
    const pendingAlertCount = openAlerts.length;
    const materialClass = normalizeMaterialClassFromType(material.type);
    const inventoryState = pendingAlertCount > 0 ? 'reserved' : 'available';
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
    const challanById = getChallansByIds
      ? await getChallansByIds(challanIds)
      : new Map();

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
    const linkedOrderDemand = refreshed.linked_item_id && getLinkedOrderItemDemand
      ? await getLinkedOrderItemDemand(refreshed.linked_item_id)
      : 0;
    const linkedPipelineDemand = getLinkedPipelineCount
      ? await getLinkedPipelineCount(material.barcode)
      : 0;

    const activePipelineRun = getActivePipelineRunForMaterial
      ? await getActivePipelineRunForMaterial(material.barcode)
      : null;

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

      if (linkedStockItemId != null && linkedStockLeafNodeId != null && itemsPorts?.stock?.applyDelta) {
        if (movementType === 'receive' || (movementType === 'adjust' && qty > 0)) {
          await itemsPorts.stock.applyDelta({
            itemId: linkedStockItemId,
            variationLeafNodeId: linkedStockLeafNodeId,
            locationId: toLocationId || 'MAIN',
            delta: qty,
            now,
          });
        } else if (movementType === 'issue' || movementType === 'consume') {
          await itemsPorts.stock.applyDelta({
            itemId: linkedStockItemId,
            variationLeafNodeId: linkedStockLeafNodeId,
            locationId: toLocationId || 'MAIN',
            delta: -qty,
            now,
          });
        } else if (movementType === 'transfer') {
          await itemsPorts.stock.applyDelta({
            itemId: linkedStockItemId,
            variationLeafNodeId: linkedStockLeafNodeId,
            locationId: fromLocationId || 'MAIN',
            delta: -qty,
            now,
          });
          await itemsPorts.stock.applyDelta({
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

  async function resetMaterialScanCount(barcode, actor = 'Demo Admin') {
    const row = await getMaterialRowByBarcode(barcode);
    if (!row) return null;
    await run(
      'UPDATE materials SET scan_count = 0, updated_at = ?, last_scanned_at = NULL WHERE id = ?',
      [new Date().toISOString(), row.id],
    );
    await run('DELETE FROM scan_history WHERE barcode = ?', [row.barcode]);
    await logMaterialActivity({
      barcode: row.barcode,
      type: 'scanReset',
      label: 'Trace reset',
      description: 'Scan history was cleared for this material.',
      actor: row.created_by || actor,
    });
    return get('SELECT * FROM materials WHERE id = ?', [row.id]);
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
      const itemDesc = itemsPorts ? await itemsPorts.describe(row.item_id) : null;
      const itemTree = getItemVariationTree ? await getItemVariationTree(Number(row.item_id)) : [];
      const selection = activeValueSelectionForLeaf
        ? activeValueSelectionForLeaf(itemTree, Number(row.variation_leaf_node_id))
        : null;
      lines.push({
        id: row.id,
        itemId: Number(row.item_id || 0),
        variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
        quantity: Number(row.quantity || 0),
        position: Number(row.position || 0),
        itemName: itemDesc?.name || '',
        itemDisplayName: itemDesc?.displayName || itemDesc?.name || '',
        variationPathLabel: selection && buildVariationPathLabel ? buildVariationPathLabel(selection.segments) : 'Base item',
        variationPathNodeIds: selection?.nodeIds || [],
      });
    }
    return lines;
  }

  async function getInventorySetById(setId) {
    const row = await get(
      `
      SELECT
        inventory_sets.*,
        COALESCE((
          SELECT SUM(quantity)
          FROM inventory_set_lines
          WHERE inventory_set_lines.set_id = inventory_sets.id
        ), 0) AS total_item_count
      FROM inventory_sets
      WHERE inventory_sets.id = ?
      `,
      [setId],
    );
    if (!row) {
      return null;
    }
    return rowToInventorySetDto(row, await getInventorySetLineDtos(row.id));
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
    const sets = [];
    for (const row of rows) {
      sets.push(await getInventorySetById(row.id));
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
    const item = getItemRowById ? await getItemRowById(itemId) : null;
    if (!item || item.is_archived) {
      const error = new Error('Selected item is not available.');
      error.statusCode = 400;
      throw error;
    }
    const itemTree = getItemVariationTree ? await getItemVariationTree(itemId) : [];
    const hasOrderableLeaves = activeTopLevelVariationProperties
      ? activeTopLevelVariationProperties(itemTree).some((propertyNode) =>
          activeChildrenForNode(propertyNode).some((child) => String(child.kind) === 'value'),
        )
      : false;
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
    const leafNode = getVariationLeafNodeById
      ? await getVariationLeafNodeById(variationLeafNodeId)
      : null;
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
    const selection = activeValueSelectionForLeaf
      ? activeValueSelectionForLeaf(itemTree, variationLeafNodeId)
      : null;
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
          'INSERT INTO inventory_sets (name, created_at, updated_at) VALUES (?, ?, ?)',
          [name, now, now],
        );
        setId = result.lastID;
      } else {
        const existing = await get(
          'SELECT id FROM inventory_sets WHERE id = ?',
          [setId],
        );
        if (!existing) {
          const error = new Error('Set not found.');
          error.statusCode = 404;
          throw error;
        }
        await run(
          'UPDATE inventory_sets SET name = ?, updated_at = ? WHERE id = ?',
          [name, now, setId],
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
    await run('DELETE FROM inventory_sets WHERE id = ?', [normalizedSetId]);
  }

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
    const inUseKeys = propertyKeysInUseByItems
      ? await propertyKeysInUseByItems(groupId)
      : new Set();
    const carriedForward = [];

    for (const row of existingRows) {
      const propertyKey = normalizePropertyKey(row.property_key);
      if (!propertyKey || incomingKeys.has(propertyKey)) {
        continue;
      }
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
      const itemDesc = itemsPorts ? await itemsPorts.describe(row.item_id) : null;
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

  async function createParentWithChildren(payload) {
    const resolvedUnit = resolveUnitPayload ? await resolveUnitPayload(payload) : { unitId: null, unit: '' };
    const actor = String(payload?.actor || '').trim() || 'Demo Admin';
    const normalizedGroupMode = String(payload.groupMode || '').trim() || null;
    const shouldCreateMasterGroup = (
      String(payload.type || '').trim() === 'Group' ||
      normalizedGroupMode === 'item_group_authoring' ||
      normalizedGroupMode === 'standalone_group' ||
      normalizedGroupMode === 'nested_group'
    );
    const parentBarcode = generateParentBarcode();
    const childBarcodes = Array.from(
      { length: Number(payload.numberOfChildren || 0) },
      (_, index) => generateChildBarcode(parentBarcode, index + 1),
    );
    const createdAt = new Date().toISOString();

    await run('BEGIN TRANSACTION');
    try {
      let linkedGroupId = null;
      if (shouldCreateMasterGroup && resolvedUnit.unitId && saveGroup) {
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

    const resolvedUnit = resolveUnitPayload ? await resolveUnitPayload(payload) : { unitId: null, unit: '' };
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
    const group = getGroupRowById ? await getGroupRowById(Number(groupId)) : null;
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
    const item = getItemRowById ? await getItemRowById(Number(itemId)) : null;
    if (!item || item.is_archived) {
      throw new Error('Selected item is not available.');
    }
    const tree = getItemVariationTree ? await getItemVariationTree(item.id) : [];
    const hasActiveVariationProperties = activeTopLevelVariationProperties
      ? activeTopLevelVariationProperties(tree).length > 0
      : false;
    const normalizedLeafId = variationLeafNodeId == null ? null : Number(variationLeafNodeId);
    if (hasActiveVariationProperties) {
      const leafPath = activeValuePathForLeaf ? activeValuePathForLeaf(tree, normalizedLeafId) : null;
      const leafNode = findVariationNodeById ? findVariationNodeById(tree, normalizedLeafId) : null;
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

  return {
    generateParentBarcode,
    generateChildBarcode,
    normalizePropertyKey,
    normalizeMovementType,
    normalizeActorLabel,
    normalizeMaterialClassFromType,
    normalizeDiscardedPropertyKeys,
    normalizeGroupUnitGovernance,
    normalizeGroupUiPreferences,
    normalizeGroupPropertyDraft,
    mergeCustomVariationValueJsonRows,
    rowToMaterialDto,
    rowToMaterialActivityDto,
    rowToInventorySetDto,
    getMaterialRowByBarcode,
    getGroupMaterialRowByGroupId,
    getInventoryStockList,
    getInventoryHealthSummary,
    getInventoryStockPosition,
    assertInventoryQuantityAvailable,
    upsertInventoryStockPosition,
    recomputeMaterialInventorySummary,
    getMaterialControlTowerDetail,
    applyInventoryMovementCore,
    applyInventoryMovement,
    logMaterialActivity,
    getMaterialActivity,
    incrementMaterialScanCount,
    resetMaterialScanCount,
    mergeInventorySetLines,
    getInventorySetLineDtos,
    getInventorySetById,
    getInventorySets,
    validateInventorySetLine,
    saveInventorySet,
    deleteInventorySet,
    retireMissingGroupProperties,
    persistMaterialGroupGovernance,
    getMaterialGroupGovernance,
    createParentWithChildren,
    createChildMaterial,
    updateMaterialRecord,
    updateMaterialGroupConfiguration,
    deleteMaterialRecord,
    linkMaterialRecordToGroup,
    linkMaterialRecordToItem,
    unlinkMaterialRecord,
  };
};
